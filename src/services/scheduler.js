const pool = require('../db/pool');
const { earliestSlot, feasibility } = require('../util/time');
const segments = require('./segments');

const HORIZON_MS = 12 * 3600_000;

async function load(id) {
  const { rows: its } = await pool.query('SELECT * FROM itinerary WHERE id=$1', [id]);
  if (!its[0]) throw Object.assign(new Error('行程不存在'), { status: 404 });
  const { rows: items } = await pool.query(`
    SELECT i.*, f.default_duration_s, f.name AS facility_name, f.walk_min_from_entrance,
           f.place_id AS f_place_id
    FROM itinerary_item i JOIN facility f ON f.id=i.facility_id
    WHERE i.itinerary_id=$1 ORDER BY i.position`, [id]);
  const facIds = [...new Set(items.map(i => i.facility_id))];
  let hours = [], maint = [];
  if (facIds.length) {
    ({ rows: hours } = await pool.query('SELECT * FROM opening_hours WHERE facility_id = ANY($1) ORDER BY facility_id, day_of_week, open_time', [facIds]));
    ({ rows: maint } = await pool.query('SELECT * FROM maintenance WHERE facility_id = ANY($1) ORDER BY start_at', [facIds]));
  }
  for (const it of items) {
    it.id = Number(it.id); it.itinerary_id = Number(it.itinerary_id);
    it.place_id = Number(it.place_id); it.facility_id = Number(it.facility_id);
    it.position = Number(it.position);
    it.hours = hours.filter(h => Number(h.facility_id) === it.facility_id);
    it.maintenance = maint.filter(m => Number(m.facility_id) === it.facility_id);
  }
  return { itinerary: its[0], items };
}

function fingerprintHours(hours) {
  return hours.map(h => `${h.day_of_week}${String(h.open_time).slice(0,5)}${String(h.close_time).slice(0,5)}${h.crosses_midnight?1:0}#${h.updated_at.toISOString()}`).sort().join('|');
}
function humanHours(hours) {
  const names = ['日','一','二','三','四','五','六'];
  const groups = new Map();
  for (const h of hours) {
    const k = `${String(h.open_time).slice(0,5)}-${String(h.close_time).slice(0,5)}${h.crosses_midnight?'(跨日)':''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(names[h.day_of_week]);
  }
  return [...groups.entries()].map(([k, v]) => `周${v.join('/')} ${k}`);
}

async function lockItem(item) {
  const snap = {
    captured_at: new Date().toISOString(),
    fingerprint: fingerprintHours(item.hours),
    hours_text: humanHours(item.hours),
  };
  await pool.query(
    `UPDATE itinerary_item SET manual_lock=TRUE, locked_window=$2, lock_note=$3 WHERE id=$1`,
    [item.id, JSON.stringify(snap), item.lock_note || '用户手工锁定']);
  item.manual_lock = true; item.locked_window = snap;
  return snap;
}

/**
 * 从 idx 起重排（完整重算 idx=0；局部修复 idx=首个受依赖影响的位置）。
 * 规则：
 *  - 锁定点：时间永不被移动；只检测并报告冲突（检修/闭馆/锁定后开放时间变化）
 *  - 非锁定点：用最早可行时窗 earliestSlot 贪心放置
 *  - 路段耗时与缓存统一走 segments.getSegment —— 两种重算看到的耗时必然相同
 */
async function rescheduleSuffix(items, idx, opts, now) {
  const tz = opts.tz || 'Asia/Tokyo';
  const changed = [];
  const conflicts = [];
  const usedCacheKeys = [];
  let anchorEnd = idx > 0 && items[idx-1].depart_at ? new Date(items[idx-1].depart_at).getTime()
                 : (opts.startAt ? new Date(opts.startAt).getTime() : null);

  for (let i = idx; i < items.length; i++) {
    const it = items[i];
    const before = { arrive_at: it.arrive_at, depart_at: it.depart_at };
    const duration = it.default_duration_s * 1000;

    // 最早到达 = 上一点离开 + 步行路段 + 设施入口内步行
    let earliest = anchorEnd;
    if (earliest != null && i > 0) {
      const prev = items[i-1];
      const seg = await segments.getSegment(prev.place_id, it.place_id, now);
      usedCacheKeys.push(seg.cache_key);
      earliest += seg.duration_s * 1000 + (it.walk_min_from_entrance || 0) * 60000;
    }
    const earliestDate = earliest != null ? new Date(earliest) : (it.arrive_at ? new Date(it.arrive_at) : null);

    if (it.manual_lock) {
      // —— 锁定点：不移动 ——
      const s = it.arrive_at ? new Date(it.arrive_at) : null;
      const e = it.depart_at ? new Date(it.depart_at) : null;
      if (s && e) {
        const bad = feasibility(it.hours, it.maintenance, s, e, tz);
        if (bad) conflicts.push({ item_id: it.id, facility_id: it.facility_id, facility_name: it.facility_name,
          code: bad.code === 'maintenance' ? 'locked_maintenance_conflict' : 'locked_closed_conflict',
          message: `锁定点保留：${it.facility_name} 仍安排在 ${s.toISOString()}，但${bad.code === 'maintenance' ? '正在检修' : '该时段不开放'}。系统不会替换或移动该点。`,
          detail: bad.message, window: { arrive_at: s.toISOString(), depart_at: e.toISOString() } });
        const snap = it.locked_window;
        if (snap && snap.fingerprint !== fingerprintHours(it.hours)) {
          conflicts.push({ item_id: it.id, facility_id: it.facility_id, facility_name: it.facility_name,
            code: 'hours_changed_after_lock',
            message: `锁定点保留：「${it.facility_name}」的开放时间在您锁定后发生变化。行程未被改动，请确认是否仍要前往。`,
            locked_hours: snap.hours_text, current_hours: humanHours(it.hours),
            locked_at: snap.captured_at,
            window: { arrive_at: s.toISOString(), depart_at: e.toISOString() } });
        }
      }
      anchorEnd = e ? e.getTime() : anchorEnd;
      continue;
    }

    if (!earliestDate) { // 没有锚点且自身无时间：跳过（首个点需要 startAt）
      conflicts.push({ item_id: it.id, facility_id: it.facility_id, code: 'no_anchor', message: '缺少起始时间' });
      continue;
    }
    const deadline = new Date(earliestDate.getTime() + HORIZON_MS);
    const slot = earliestSlot(it.hours, it.maintenance, earliestDate, deadline, duration, tz);
    if (slot) {
      it.arrive_at = slot.start; it.depart_at = slot.end;
    } else {
      // 无可行时窗：保留原计划（若有）并报告，绝不静默换点
      conflicts.push({ item_id: it.id, facility_id: it.facility_id, facility_name: it.facility_name,
        code: 'no_feasible_slot', message: `「${it.facility_name}」在步行可达后的 12 小时内没有可用时窗（检修或闭馆），该点保留待人工处理` });
      it.arrive_at = earliestDate; it.depart_at = new Date(earliestDate.getTime() + duration);
    }
    anchorEnd = new Date(it.depart_at).getTime();
    if (before.arrive_at?.getTime?.() !== new Date(it.arrive_at).getTime() ||
        before.depart_at?.getTime?.() !== new Date(it.depart_at).getTime()) {
      changed.push({ item_id: it.id, facility_id: it.facility_id,
        old: before.arrive_at ? { arrive_at: new Date(before.arrive_at).toISOString(), depart_at: new Date(before.depart_at).toISOString() } : null,
        new: { arrive_at: new Date(it.arrive_at).toISOString(), depart_at: new Date(it.depart_at).toISOString() } });
    }
  }
  return { changed, conflicts, usedCacheKeys };
}

async function persist(items) {
  for (const it of items) {
    if (!it.arrive_at) continue;
    await pool.query('UPDATE itinerary_item SET arrive_at=$2, depart_at=$3 WHERE id=$1',
      [it.id, it.arrive_at, it.depart_at]);
  }
}

// 计算受影响的首个下标（依赖追踪）
function firstAffectedIndex(items, trigger) {
  if (!trigger) return 0;
  let idx = items.length;
  if (trigger.facilityIds) {
    const ids = trigger.facilityIds.map(Number);
    items.forEach((it, i) => { if (ids.includes(it.facility_id)) idx = Math.min(idx, i); });
  }
  if (trigger.placeId) { // 地点坐标/边变化：影响从“进入该边之后”的点
    items.forEach((it, i) => {
      if (i > 0 && (items[i-1].place_id === trigger.placeId || it.place_id === trigger.placeId)) idx = Math.min(idx, i);
    });
  }
  return idx === items.length ? -1 : idx;
}

async function recompute(id, { mode = 'full', trigger = null, startAt = null, tz = 'Asia/Tokyo' } = {}) {
  const now = new Date();
  const { itinerary, items } = await load(id);
  const idx = mode === 'full' ? 0 : Math.max(0, firstAffectedIndex(items, trigger));
  const result = await rescheduleSuffix(items, idx, { startAt: startAt || items[0]?.arrive_at, tz }, now);
  await persist(items);
  const cacheFresh = await segments.freshnessSnapshot(result.usedCacheKeys);
  const log = await pool.query(`
    INSERT INTO itinerary_recompute_log (itinerary_id,mode,changed_items,conflicts,cache_fresh)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, mode, JSON.stringify(result.changed), JSON.stringify(result.conflicts), JSON.stringify(cacheFresh)]);
  await pool.query('UPDATE itinerary SET version=version+1, updated_at=now() WHERE id=$1', [id]);
  return { mode, start_index: idx, changed: result.changed, conflicts: result.conflicts,
    cache_freshness: cacheFresh, items: serialize(items), log_id: log.rows[0].id };
}

function serialize(items) {
  return items.map(it => ({
    id: it.id, position: it.position, place_id: it.place_id, facility_id: it.facility_id,
    facility_name: it.facility_name,
    arrive_at: it.arrive_at ? new Date(it.arrive_at).toISOString() : null,
    depart_at: it.depart_at ? new Date(it.depart_at).toISOString() : null,
    manual_lock: it.manual_lock, lock_note: it.lock_note,
    locked_window: it.locked_window,
  }));
}

// 检测当前行程所有锁定冲突（GET 时调用，不修改计划）
async function detectConflicts(id, tz = 'Asia/Tokyo') {
  const { items } = await load(id);
  const conflicts = [];
  for (const it of items) {
    if (!it.manual_lock || !it.arrive_at) continue;
    const s = new Date(it.arrive_at), e = new Date(it.depart_at);
    const bad = feasibility(it.hours, it.maintenance, s, e, tz);
    if (bad) conflicts.push({ item_id: it.id, facility_name: it.facility_name,
      code: bad.code === 'maintenance' ? 'locked_maintenance_conflict' : 'locked_closed_conflict',
      message: `锁定点「${it.facility_name}」与当前${bad.code === 'maintenance' ? '检修安排' : '开放时间'}冲突；已保留未移动`, detail: bad.message });
    if (it.locked_window?.fingerprint && it.locked_window.fingerprint !== fingerprintHours(it.hours)) {
      conflicts.push({ item_id: it.id, facility_name: it.facility_name, code: 'hours_changed_after_lock',
        message: `「${it.facility_name}」开放时间在锁定后变化；锁定保留`,
        locked_hours: it.locked_window.hours_text, current_hours: humanHours(it.hours) });
    }
  }
  return conflicts;
}

module.exports = { load, recompute, rescheduleSuffix, lockItem, detectConflicts, fingerprintHours, humanHours, serialize, firstAffectedIndex };
