const pool = require('../db/pool');
const { haversine } = require('./catalog');

const WALK_SPEED_MPS = Number(process.env.WALK_SPEED_MPS || 1.25); // 4.5km/h
const CACHE_TTL_MS = Number(process.env.SEGMENT_TTL_MS || 24 * 3600_000);
const OSRM_VERSION = process.env.OSRM_VERSION || 'haversine-1';

async function placeCoords(id) {
  const { rows } = await pool.query('SELECT id,lat,lng FROM place WHERE id=$1', [id]);
  if (!rows[0]) throw Object.assign(new Error('地点不存在'), { status: 404 });
  return rows[0];
}

// 实测边（步行方向相关，故 from/to 分别查）
async function measuredEdge(from, to) {
  const { rows } = await pool.query(
    `SELECT w.distance_m, w.duration_s, w.measured_at
     FROM walking_edge w WHERE w.from_place=$1 AND w.to_place=$2`, [from, to]); // $1=from,$2=to
  return rows[0] || null;
}

async function osrmSegment(a, b) {
  if (!process.env.OSRM_BASE_URL) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const url = `${process.env.OSRM_BASE_URL}/route/v1/foot/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const route = json.routes?.[0];
    if (!route) return null;
    return { distance_m: Math.round(route.distance), duration_s: Math.round(route.duration), source: 'osrm' };
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * 获取路段：先看缓存新鲜度，再按 measured → osrm → haversine 回退。
 * 全量重算与局部修复都只通过本函数拿耗时，保证“同一路段只有一个答案”。
 */
async function getSegment(from, to, now = new Date(), { forceRefresh = false } = {}) {
  const key = `${from}:${to}:foot:${OSRM_VERSION}`;
  if (!forceRefresh) {
    const { rows } = await pool.query(
      `SELECT * FROM segment_cache WHERE cache_key=$1 AND invalid=FALSE AND expires_at > $2`,
      [key, now]);
    if (rows[0]) return { ...rows[0], cache_hit: true };
  }
  const [a, b] = await Promise.all([placeCoords(from), placeCoords(to)]);
  const measured = await measuredEdge(from, to);
  let result;
  if (measured && measured.duration_s) {
    result = { distance_m: measured.distance_m ?? haversine(a.lat,a.lng,b.lat,b.lng), duration_s: measured.duration_s, source: 'measured' };
  } else {
    const osrm = await osrmSegment(a, b);
    if (osrm) result = osrm;
    else {
      const d = haversine(a.lat, a.lng, b.lat, b.lng);
      result = { distance_m: d, duration_s: Math.round(d / WALK_SPEED_MPS), source: 'haversine' };
    }
  }
  const expires = new Date(now.getTime() + CACHE_TTL_MS);
  await pool.query(`
    INSERT INTO segment_cache (cache_key,from_place,to_place,duration_s,distance_m,source,computed_at,expires_at,invalid)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)
    ON CONFLICT (cache_key) DO UPDATE
      SET duration_s=EXCLUDED.duration_s, distance_m=EXCLUDED.distance_m, source=EXCLUDED.source,
          computed_at=EXCLUDED.computed_at, expires_at=EXCLUDED.expires_at, invalid=FALSE`,
    [key, from, to, result.duration_s, result.distance_m, result.source, now, expires]);
  return { cache_key: key, from_place: from, to_place: to, duration_s: result.duration_s,
    distance_m: result.distance_m, source: result.source, computed_at: now, expires_at: expires, cache_hit: false };
}

// 数据侧变化时的显式失效（局部修复依赖追踪会调用）
async function invalidateForPlace(placeId) {
  const { rowCount } = await pool.query(
    `UPDATE segment_cache SET invalid=TRUE
     WHERE from_place=$1 OR to_place=$1 OR from_place=$2 OR to_place=$2`, [placeId, placeId]);
  return rowCount;
}

async function invalidateAll() {
  const { rowCount } = await pool.query(`UPDATE segment_cache SET invalid=TRUE WHERE invalid=FALSE`);
  return rowCount;
}

// 缓存新鲜度快照（写入重算审计并返回给调用方比对）
async function freshnessSnapshot(keys = null) {
  const sql = keys
    ? { text: `SELECT source, count(*)::int n, min(expires_at) earliest_expiry,
                     bool_or(expires_at <= now()) stale_count_present,
                     count(*) FILTER (WHERE invalid) invalid_n,
                     count(*) FILTER (WHERE expires_at <= now()) expired_n
              FROM segment_cache WHERE cache_key = ANY($1) GROUP BY source`, values: [keys] }
    : { text: `SELECT source, count(*)::int n, min(expires_at) earliest_expiry,
                     count(*) FILTER (WHERE invalid) invalid_n,
                     count(*) FILTER (WHERE expires_at <= now()) expired_n
              FROM segment_cache GROUP BY source` };
  const { rows } = await pool.query(sql.text, sql.values);
  return { at: new Date().toISOString(), by_source: rows };
}

module.exports = { getSegment, invalidateForPlace, invalidateAll, freshnessSnapshot, WALK_SPEED_MPS, OSRM_VERSION };
