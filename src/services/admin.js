const pool = require('../db/pool');
const segments = require('./segments');

// 新增维护（可挂设施/子设施；支持跨日）
async function addMaintenance({ facility_id, title, start_at, end_at, reason, source_id }) {
  const s = new Date(start_at), e = new Date(end_at);
  if (!(e > s)) throw Object.assign(new Error('维护结束时间必须晚于开始时间'), { status: 400 });
  const { rows } = await pool.query(`
    INSERT INTO maintenance (facility_id,title,start_at,end_at,reason,source_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [facility_id, title, s, e, reason || null, source_id || null]);
  return rows[0];
}

async function removeMaintenance(id) {
  const r = await pool.query('DELETE FROM maintenance WHERE id=$1', [id]);
  if (!r.rowCount) throw Object.assign(new Error('维护记录不存在'), { status: 404 });
  return { deleted: Number(id) };
}

/**
 * 地点合并：旧地点并入保留地点。
 * 设施迁移、别名迁移、旧地点标记 inactive + merged_into；历史行程引用仍可解析到保留地点。
 */
async function mergePlaces(oldId, keepId) {
  if (Number(oldId) === Number(keepId)) throw Object.assign(new Error('不能合并地点自身'), { status: 400 });
  return pool.withTx(async (client) => {
    const { rows: ps } = await client.query('SELECT * FROM place WHERE id = ANY($1)', [[oldId, keepId]]);
    if (ps.length !== 2) throw Object.assign(new Error('地点不存在'), { status: 404 });
    const old = ps.find(p => Number(p.id) === Number(oldId));
    const keep = ps.find(p => Number(p.id) === Number(keepId));
    if (old.merged_into) throw Object.assign(new Error('旧地点已经被合并过'), { status: 409 });

    await client.query('UPDATE facility SET place_id=$2 WHERE place_id=$1', [oldId, keepId]);
    // 别名冲突时保留 keep 的
    await client.query(`DELETE FROM place_alias a USING place_alias b
      WHERE a.alias=b.alias AND a.place_id=$1 AND b.place_id=$2`, [oldId, keepId]);
    await client.query('UPDATE place_alias SET place_id=$2 WHERE place_id=$1', [oldId, keepId]);
    await client.query(
      `INSERT INTO place_alias (place_id,alias) VALUES ($1,$2) ON CONFLICT (alias) DO NOTHING`,
      [keepId, old.name]);
    // 步行边重定向（同方向冲突保留 keep 侧）
    await client.query(`DELETE FROM walking_edge e USING walking_edge k
      WHERE ((e.from_place=$1 AND e.to_place=k.to_place AND k.from_place=$2)
          OR (e.to_place=$1 AND e.from_place=k.from_place AND k.to_place=$2))`, [oldId, keepId]);
    // 会直接变成 keep->keep 自环的边（old->keep / keep->old）在重定向前删除
    await client.query(
      `DELETE FROM walking_edge
       WHERE (from_place=$1 AND to_place=$2) OR (from_place=$2 AND to_place=$1)`,
      [oldId, keepId]);
    await client.query('UPDATE walking_edge SET from_place=$2 WHERE from_place=$1', [oldId, keepId]);
    await client.query('UPDATE walking_edge SET to_place=$2 WHERE to_place=$1', [oldId, keepId]);
    // 兜底清理任何自环
    await client.query('DELETE FROM walking_edge WHERE from_place=to_place');
    // 行程点改指保留地点
    await client.query('UPDATE itinerary_item SET place_id=$2 WHERE place_id=$1', [oldId, keepId]);
    await client.query(`UPDATE place SET active=FALSE, merged_into=$2,
      verification_note=COALESCE(verification_note,'已合并') WHERE id=$1`, [oldId, keepId]);
    await segments.invalidateForPlace(keepId);
    return { merged: Number(oldId), into: Number(keepId) };
  });
}

// 链接巡检：真实 HEAD/GET；失败/4xx/5xx 标记来源 dead/stale
async function checkLink(sourceId) {
  const { rows } = await pool.query('SELECT * FROM source_record WHERE id=$1', [sourceId]);
  const src = rows[0];
  if (!src) throw Object.assign(new Error('来源不存在'), { status: 404 });
  let ok = false, http = null, detail = null;
  if (!src.url) { detail = '来源无 URL（如实地调查），按 active 保留'; ok = true; }
  else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(src.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      http = res.status;
      ok = res.ok;
      detail = res.statusText || `HTTP ${res.status}`;
    } catch (e) {
      detail = `请求失败：${e.message}`;
      ok = false;
    }
  }
  const status = !src.url ? src.status : (ok ? 'active' : (http >= 410 ? 'dead' : 'stale'));
  await pool.query('UPDATE source_record SET status=$2 WHERE id=$1', [sourceId, status]);
  const { rows: ins } = await pool.query(
    `INSERT INTO link_check (source_id,http_status,ok,detail) VALUES ($1,$2,$3,$4) RETURNING *`,
    [sourceId, http, ok, detail]);
  return { ...ins[0], source_status: status };
}

async function listSources() {
  const { rows } = await pool.query(`
    SELECT s.*, lc.checked_at AS last_checked_at, lc.ok AS last_ok, lc.http_status AS last_http
    FROM source_record s
    LEFT JOIN LATERAL (SELECT * FROM link_check WHERE source_id=s.id ORDER BY checked_at DESC LIMIT 1) lc ON TRUE
    ORDER BY s.id`);
  return rows;
}

// 待核标记
async function setVerification(placeId, needs, note) {
  const { rowCount } = await pool.query(
    'UPDATE place SET needs_verification=$2, verification_note=$3 WHERE id=$1',
    [placeId, needs, note || null]);
  if (!rowCount) throw Object.assign(new Error('地点不存在'), { status: 404 });
  return { id: Number(placeId), needs_verification: needs, verification_note: note || null };
}

// 离线包：当前可用（未过期且 active），过期包显式返回 stale
async function offlineStatus(now = new Date()) {
  const { rows } = await pool.query('SELECT * FROM offline_package ORDER BY published_at DESC');
  return rows.map(p => ({
    id: p.id, version: p.version, published_at: p.published_at, expires_at: p.expires_at,
    manifest: p.manifest, active: p.active,
    state: !p.active ? 'inactive' : (new Date(p.expires_at) <= now ? 'expired' : 'current'),
    message: !p.active ? '已停用' : (new Date(p.expires_at) <= now
      ? `离线包 ${p.version} 已于 ${new Date(p.expires_at).toISOString()} 过期，请重新下载` : '最新可用离线包'),
  }));
}

// 修改开放时间（用于验收“锁定后开放时间变化”）。会保留来源与生效范围。
async function replaceHours(facilityId, hours, sourceId) {
  return pool.withTx(async (client) => {
    await client.query('DELETE FROM opening_hours WHERE facility_id=$1', [facilityId]);
    for (const h of hours) {
      await client.query(`INSERT INTO opening_hours
        (facility_id,day_of_week,open_time,close_time,crosses_midnight,source_id)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [facilityId, h.day_of_week, h.open_time, h.close_time, !!h.crosses_midnight, sourceId || h.source_id || null]);
    }
    const { rows } = await client.query('SELECT * FROM opening_hours WHERE facility_id=$1', [facilityId]);
    return rows;
  });
}

// 步行边更新 -> 使相关路段缓存失效（局部修复触发器之一）
async function upsertWalkingEdge({ from_place, to_place, distance_m, duration_s, source_id }) {
  const { rows } = await pool.query(`
    INSERT INTO walking_edge (from_place,to_place,distance_m,duration_s,source_id,measured_at)
    VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)
    ON CONFLICT (from_place,to_place) DO UPDATE
      SET distance_m=EXCLUDED.distance_m, duration_s=EXCLUDED.duration_s,
          source_id=EXCLUDED.source_id, measured_at=CURRENT_DATE
    RETURNING *`, [from_place, to_place, distance_m, duration_s ?? null, source_id ?? null]);
  const n = await segments.invalidateForPlace(from_place);
  return { edge: rows[0], cache_entries_invalidated: n };
}

module.exports = { addMaintenance, removeMaintenance, mergePlaces, checkLink, listSources,
  setVerification, offlineStatus, replaceHours, upsertWalkingEdge };
