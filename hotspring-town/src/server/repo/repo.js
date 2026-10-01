// 仓储层：所有 SQL 集中在此，服务层只拿结构化数据。
import { query, withCompensatingTx } from '../db/index.js';
import { newId } from '../util/id.js';

// ---------- 世界模型 ----------
export async function loadWorld() {
  const p = await query(`SELECT id,name,kind,lat,lng,address,phone,home_url,status,
      merged_into_id,family_friendly,description,data_updated_at FROM places ORDER BY id`);
  const places = p.rows;
  const f = await query(`SELECT id,place_id,name,kind,lat,lng,family_friendly,family_attrs,
      note,data_updated_at FROM facilities ORDER BY id`);
  const facilities = f.rows.map(parseDates);
  const w = await query(`SELECT id,facility_id,dow,open_min,close_min,note FROM service_windows`);
  const d = await query(`SELECT id,facility_id,cal_date,open_min,close_min,closed,note FROM date_windows`);
  const m = await query(`SELECT id,facility_id,place_id,title,start_at,end_at,status,note,source_id
      FROM maintenance ORDER BY start_at`);
  const e = await query(`SELECT id,from_place,to_place,walk_sec,path_kind,note FROM walking_edges`);
  return {
    places,
    facilities: facilities.map((x) => ({ ...x, family_attrs: x.family_attrs || [] })),
    windows: w.rows,
    dateWindows: d.rows.map((r) => ({ ...r, cal_date: toDateStr(r.cal_date) })),
    maintenance: m.rows,
    edges: e.rows,
  };
}
function parseDates(row) {
  return { ...row, data_updated_at: row.data_updated_at ? new Date(row.data_updated_at).toISOString() : null };
}
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export async function getFacility(id) {
  const { rows } = await query(`SELECT * FROM facilities WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function getPlace(id) {
  const { rows } = await query(`SELECT * FROM places WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function getSpringQuality(facilityId) {
  const { rows } = await query(`SELECT * FROM spring_quality WHERE facility_id=$1`, [facilityId]);
  return rows[0] || null;
}
export async function getSourcesByIds(ids) {
  if (!ids.length) return [];
  // 动态 IN 占位符：兼容 pg-mem（其 ANY($1) 数组绑定在部分路径下不可靠）与真实 PG
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(`SELECT * FROM sources WHERE id IN (${ph})`, ids);
  return rows;
}
export async function listSources() {
  const { rows } = await query(`SELECT * FROM sources ORDER BY id`);
  return rows;
}

// ---------- 地点详情（含合并重定向） ----------
export async function placeDetail(id) {
  let place = await getPlace(id);
  const redirects = [];
  while (place && place.status === 'merged' && place.merged_into_id) {
    redirects.push({ from: place.id, to: place.merged_into_id });
    place = await getPlace(place.merged_into_id);
  }
  if (!place) return null;
  const { rows: facilities } = await query(`SELECT * FROM facilities WHERE place_id=$1 ORDER BY kind,id`, [place.id]);
  return { place, redirect_chain: redirects, facilities: facilities.map((x) => ({ ...x, family_attrs: x.family_attrs || [] })) };
}

// ---------- 维护 ----------
export async function listMaintenance({ futureOnly = false, date = null } = {}) {
  let sql = `SELECT * FROM maintenance`;
  const params = [];
  const where = [];
  if (futureOnly) { params.push(new Date()); where.push(`end_at >= $${params.length}`); }
  if (date) {
    params.push(`${date}T00:00:00+09:00`);
    params.push(`${date}T23:59:59+09:00`);
    where.push(`start_at <= $${params.length} AND end_at >= $${params.length - 1}`);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY start_at`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function createMaintenance(input) {
  const id = input.id || newId('m');
  await query(
    `INSERT INTO maintenance(id,facility_id,place_id,title,start_at,end_at,status,note,source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, input.facility_id ?? null, input.place_id ?? null, input.title,
     input.start_at, input.end_at, input.status || 'scheduled', input.note ?? null,
     input.source_id ?? null]);
  return id;
}

// ---------- 行程 ----------
export async function createItinerary({ title, visitDate, startPlaceId, deviceId }) {
  const id = newId('it');
  await query(
    `INSERT INTO itineraries(id,title,visit_date,start_place,created_by)
     VALUES($1,$2,$3,$4,$5)`,
    [id, title, visitDate, startPlaceId ?? null, deviceId ?? null]);
  await logEvent(id, deviceId, 0, 1, 'create', { title, visitDate, startPlaceId });
  return id;
}

export async function getItinerary(id) {
  const { rows } = await query(`SELECT * FROM itineraries WHERE id=$1`, [id]);
  if (!rows[0]) return null;
  const it = rows[0];
  it.visit_date = toDateStr(it.visit_date);
  const items = await query(
    `SELECT * FROM itinerary_items WHERE itinerary_id=$1 ORDER BY position`, [id]);
  it.items = items.rows.map((r) => ({ ...r, conflict: r.conflict || null, family_attrs: undefined }));
  return it;
}

export async function listItineraries() {
  const { rows } = await query(`SELECT id,title,visit_date,version,updated_at FROM itineraries ORDER BY updated_at DESC`);
  return rows.map((r) => ({ ...r, visit_date: toDateStr(r.visit_date) }));
}

// 乐观锁更新：expectedVersion 不匹配 -> null（双设备冲突）
export async function saveItineraryPlan(id, items, { deviceId, expectedVersion, kind = 'edit', payload = {} }) {
  return withCompensatingTx(async (tx) => {
    const cur = await tx.query(`SELECT version FROM itineraries WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rows[0]) { const e = new Error('itinerary not found'); e.status = 404; throw e; }
    if (Number(cur.rows[0].version) !== Number(expectedVersion)) {
      return { ok: false, currentVersion: Number(cur.rows[0].version) };
    }
    const oldRows = (await tx.query(`SELECT * FROM itinerary_items WHERE itinerary_id=$1 ORDER BY position`, [id])).rows;
    // 逆操作：先删新插入，再恢复旧行
    tx.undo(`DELETE FROM itinerary_items WHERE itinerary_id=$1`, [id]);
    for (const r of oldRows) {
      tx.undo(
        `INSERT INTO itinerary_items(id,itinerary_id,facility_id,facility_snapshot,position,planned_start,planned_end,
           locked,locked_note,conflict,dep_hash,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.id, r.itinerary_id, r.facility_id, r.facility_snapshot, r.position,
         r.planned_start, r.planned_end, r.locked, r.locked_note,
         JSON.stringify(r.conflict), r.dep_hash, r.created_at]);
    }
    await tx.query(`DELETE FROM itinerary_items WHERE itinerary_id=$1`, [id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await tx.query(
        `INSERT INTO itinerary_items(id,itinerary_id,facility_id,facility_snapshot,position,
            planned_start,planned_end,locked,locked_note,conflict,dep_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [it.id || newId('ii'), id, it.facility_id, it.facility_snapshot ?? null, i,
         it.planned_start ? new Date(it.planned_start) : null,
         it.planned_end ? new Date(it.planned_end) : null,
         !!it.locked, it.locked_note ?? null,
         JSON.stringify(it.conflict ?? null), it.dep_hash ?? null]);
    }
    const nextV = Number(expectedVersion) + 1;
    await tx.query(`UPDATE itineraries SET version=$1, updated_at=now() WHERE id=$2`, [nextV, id]);
    await tx.query(
      `INSERT INTO itinerary_events(id,itinerary_id,device_id,version_from,version_to,kind,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [newId('ev'), id, deviceId ?? null, Number(expectedVersion), nextV, kind, JSON.stringify(payload)]);
    return { ok: true, version: nextV };
  });
}

export async function listEvents(itineraryId) {
  const { rows } = await query(
    `SELECT * FROM itinerary_events WHERE itinerary_id=$1 ORDER BY created_at, id`, [itineraryId]);
  return rows;
}

// ---------- 地点合并 ----------
export async function mergePlaces(keptId, removedId, { reason, deviceId } = {}) {
  return withCompensatingTx(async (tx) => {
    const keptR = await tx.query(`SELECT * FROM places WHERE id=$1`, [keptId]);
    const remR = await tx.query(`SELECT * FROM places WHERE id=$1`, [removedId]);
    if (!keptR.rows[0] || !remR.rows[0]) {
      const e = new Error('place not found'); e.status = 404; throw e;
    }
    const removed = remR.rows[0];
    if (removed.status === 'merged') {
      const e = new Error('removed place already merged'); e.status = 409; throw e;
    }
    // 1) 迁移设施（保留 id，仅换 place_id）
    const moved = (await tx.query(
      `UPDATE facilities SET place_id=$1, data_updated_at=now() WHERE place_id=$2 RETURNING id`,
      [keptId, removedId])).rows.map((r) => r.id);
    tx.undo(inListUpdate('facilities', 'place_id', removedId, moved), moved);
    // 2) 迁移步行边（合并后可能产生重复，取较短者保留）
    const edges = (await tx.query(`SELECT * FROM walking_edges WHERE from_place=$1 OR to_place=$1`, [removedId])).rows;
    for (const ed of edges) {
      const from = ed.from_place === removedId ? keptId : ed.from_place;
      const to = ed.to_place === removedId ? keptId : ed.to_place;
      if (from === to) {
        await tx.query(`DELETE FROM walking_edges WHERE id=$1`, [ed.id]);
        tx.undo(`INSERT INTO walking_edges(id,from_place,to_place,walk_sec,path_kind,note)
                 VALUES($1,$2,$3,$4,$5,$6)`,
          [ed.id, ed.from_place, ed.to_place, ed.walk_sec, ed.path_kind, ed.note]);
        continue;
      }
      const dup = (await tx.query(`SELECT id,walk_sec FROM walking_edges WHERE from_place=$1 AND to_place=$2`, [from, to])).rows[0]
        || (await tx.query(`SELECT id,walk_sec FROM walking_edges WHERE from_place=$1 AND to_place=$2`, [to, from])).rows[0];
      if (dup) {
        const keepSec = Math.min(dup.walk_sec, ed.walk_sec);
        const oldSec = dup.walk_sec;
        // 删迁移边；若它更短则更新重复边
        await tx.query(`DELETE FROM walking_edges WHERE id=$1`, [ed.id]);
        if (keepSec !== oldSec) {
          await tx.query(`UPDATE walking_edges SET walk_sec=$1 WHERE id=$2`, [keepSec, dup.id]);
          tx.undo(`UPDATE walking_edges SET walk_sec=$1 WHERE id=$2`, [oldSec, dup.id]);
        }
        tx.undo(`INSERT INTO walking_edges(id,from_place,to_place,walk_sec,path_kind,note)
                 VALUES($1,$2,$3,$4,$5,$6)`,
          [ed.id, ed.from_place, ed.to_place, ed.walk_sec, ed.path_kind, ed.note]);
      } else {
        const oldFrom = ed.from_place; const oldTo = ed.to_place;
        await tx.query(`UPDATE walking_edges SET from_place=$1,to_place=$2 WHERE id=$3`, [from, to, ed.id]);
        tx.undo(`UPDATE walking_edges SET from_place=$1,to_place=$2 WHERE id=$3`, [oldFrom, oldTo, ed.id]);
      }
    }
    // 3) 维护记录 place_id 迁移
    const movedM = (await tx.query(
      `UPDATE maintenance SET place_id=$1 WHERE place_id=$2 RETURNING id`, [keptId, removedId])).rows.map((r) => r.id);
    tx.undo(inListUpdate('maintenance', 'place_id', removedId, movedM), movedM);
    // 4) 起点引用
    const its = (await tx.query(
      `UPDATE itineraries SET start_place=$1 WHERE start_place=$2 RETURNING id`, [keptId, removedId])).rows.map((r) => r.id);
    tx.undo(inListUpdate('itineraries', 'start_place', removedId, its), its);
    // 5) 旧点标记合并（不删：保留重定向与审计）
    await tx.query(
      `UPDATE places SET status='merged', merged_into_id=$1, data_updated_at=now() WHERE id=$2`,
      [keptId, removedId]);
    tx.undo(`UPDATE places SET status='active', merged_into_id=NULL WHERE id=$1`, [removedId]);
    // 6) 审计
    const mergeId = newId('mg');
    await tx.query(
      `INSERT INTO place_merges(id,kept_id,removed_id,reason,detail) VALUES($1,$2,$3,$4,$5)`,
      [mergeId, keptId, removedId, reason ?? null,
       JSON.stringify({ moved_facilities: moved, moved_edges: edges.length, moved_maintenance: movedM.length })]);
    tx.undo(`DELETE FROM place_merges WHERE id=$1`, [mergeId]);
    return { ok: true, merge_id: mergeId, kept_id: keptId, removed_id: removedId,
      moved_facilities: moved, moved_edges: edges.length };
  });
}

// ---------- 来源链接探测 ----------
export async function markLinkCheck(id, { httpStatus, linkState, okAt }) {
  await query(
    `UPDATE sources SET http_status=$1,link_state=$2,last_ok_at=$3,fetched_at=now() WHERE id=$4`,
    [httpStatus ?? null, linkState, okAt ? new Date(okAt) : null, id]);
}

// ---------- 离线包 ----------
export async function publishOfflinePackage({ versionTag, contentHash, payload, expiresAt }) {
  const id = newId('op');
  await query(
    `INSERT INTO offline_packages(id,version_tag,content_hash,payload,expires_at)
     VALUES($1,$2,$3,$4,$5)`,
    [id, versionTag, contentHash, JSON.stringify(payload), new Date(expiresAt)]);
  return id;
}
export async function getOfflinePackage(id) {
  const { rows } = await query(`SELECT * FROM offline_packages WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function latestOfflinePackage() {
  const { rows } = await query(`SELECT * FROM offline_packages ORDER BY published_at DESC LIMIT 1`);
  return rows[0] || null;
}

async function logEvent(itineraryId, deviceId, vFrom, vTo, kind, payload) {
  await query(
    `INSERT INTO itinerary_events(id,itinerary_id,device_id,version_from,version_to,kind,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [newId('ev'), itineraryId, deviceId ?? null, vFrom, vTo, kind, JSON.stringify(payload || {})]);
}

// ---------- 时窗管理（模拟“开放时间改变”） ----------
export async function setWeeklyWindow({ id, facilityId, dow, openMin, closeMin, note }) {
  return withCompensatingTx(async (tx) => {
    const old = (await tx.query(`SELECT * FROM service_windows WHERE id=$1`, [id])).rows[0];
    if (!old) {
      // upsert 新窗口
      await tx.query(
        `INSERT INTO service_windows(id,facility_id,dow,open_min,close_min,note)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (facility_id, dow, open_min) DO UPDATE SET close_min=$6, note=$7`,
        [id, facilityId, dow, openMin, closeMin, note ?? null, note ?? null]);
      tx.undo(`DELETE FROM service_windows WHERE id=$1`, [id]);
      return { created: true, id };
    }
    tx.undo(`UPDATE service_windows SET facility_id=$1,dow=$2,open_min=$3,close_min=$4,note=$5 WHERE id=$6`,
      [old.facility_id, old.dow, old.open_min, old.close_min, old.note, id]);
    await tx.query(
      `UPDATE service_windows SET facility_id=$1,dow=$2,open_min=$3,close_min=$4,note=$5 WHERE id=$6`,
      [facilityId, dow, openMin, closeMin, note ?? null, id]);
    return { updated: true, id, old: { dow: old.dow, open_min: old.open_min, close_min: old.close_min } };
  });
}

export async function upsertDateWindow({ id, facilityId, calDate, openMin = null, closeMin = null, closed = false, note = null }) {
  return withCompensatingTx(async (tx) => {
    const old = (await tx.query(`SELECT * FROM date_windows WHERE facility_id=$1 AND cal_date=$2`, [facilityId, calDate])).rows[0];
    if (old) {
      tx.undo(`UPDATE date_windows SET open_min=$1,close_min=$2,closed=$3,note=$4,id=$5 WHERE id=$6`,
        [old.open_min, old.close_min, old.closed, old.note, old.id, old.id]);
    } else {
      tx.undo(`DELETE FROM date_windows WHERE id=$1`, [id]);
    }
    await tx.query(
      `INSERT INTO date_windows(id,facility_id,cal_date,open_min,close_min,closed,note)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (facility_id, cal_date) DO UPDATE
         SET open_min=$4,close_min=$5,closed=$6,note=$7`,
      [id, facilityId, calDate, openMin, closeMin, closed, note]);
    return { id, old: old || null };
  });
}

export async function touchFacilityVersion(facilityId) {
  await query(`UPDATE facilities SET data_updated_at=now() WHERE id=$1`, [facilityId]);
}

// 生成 UPDATE ... SET col=$1 WHERE id IN ($2,...) 的参数化 SQL（补偿事务用）
function inListUpdate(table, col, value, ids) {
  if (!ids.length) return { sql: `UPDATE ${table} SET ${col}=NULL WHERE 1=0`, params: [] };
  const ph = ids.map((_, i) => `$${i + 2}`).join(',');
  return { sql: `UPDATE ${table} SET ${col}=$1 WHERE id IN (${ph})`, params: [value, ...ids] };
}
