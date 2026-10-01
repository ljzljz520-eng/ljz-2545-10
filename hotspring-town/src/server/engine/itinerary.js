// 行程编排引擎（纯函数，不碰数据库，便于验收测试）
//
// 两种更新方式：
//  1) fullRecompute：从首个点开始整体重排
//  2) localRepair  ：按依赖指纹找出受影响的点，只重排「首个受影响点」之后的部分；
//                    未受影响的点直接复用缓存结果
// 一致性保证：对未受影响的点，两种方式算出的 planned_start/planned_end 必须逐字节相同；
//  锁定点在两种方式下都保持用户给定的时刻不动，只追加冲突说明（绝不偷换）。
import { walkBetween } from './walking.js';
import { availabilityOnDate, conflictsForVisit } from './availability.js';
import { atMinute, now as clockNow, localDate } from '../util/time.js';
import { fingerprint } from '../util/hash.js';

export const DEFAULT_DURATIONS = {
  bath: 60, room: 60, restaurant: 75, play: 60, shop: 30, rest: 20, other: 20,
};

// items: [{facility_id, locked, planned_start?, duration_min?, note?}]
// world: {facilities, places, windows, dateWindows, maintenance, graph}
export function fullRecompute(world, items, ctx) {
  const base = { ...ctx, graph: world.graph, computedAt: clockNow().toISOString() };
  const scheduled = scheduleChain(world, items.map((it) => ({ ...it })), 0, base.cursor ?? null, base);
  return finalize(world, scheduled, base, 'full');
}

// changes: { facilities?:[id], windows?:[facilityId...], maintenance?:[id],
//            edges?:[edgeId...], places?:[id] }  —— 标记“哪些基础数据变了”
export function localRepair(world, items, ctx, changes = {}) {
  const base = { ...ctx, graph: world.graph, computedAt: clockNow().toISOString() };
  const copy = items.map((it) => ({ ...it }));
  const firstBaseHit = findFirstAffected(world, copy, base, changes);
  if (firstBaseHit === -1) {
    return { ...finalize(world, copy, base, 'local'), repair: { changed: false, reason: 'no_dependency_hit', affected_indexes: [], reused_indexes: copy.map((_, i) => i) } };
  }
  // 锚点 = 前一个点缓存的结束时间与地点（未受影响，直接复用）
  let cursor = null;
  if (firstBaseHit > 0) {
    const anchor = copy[firstBaseHit - 1];
    if (anchor.planned_end) cursor = { at: new Date(anchor.planned_end), placeId: placeOf(world, anchor.facility_id) };
  }
  const before = copy.map((it) => ({ s: it.planned_start || null, e: it.planned_end || null, c: it.conflict || null }));
  const rescheduled = scheduleChain(world, copy, firstBaseHit, cursor, base);
  // 实际变化的点：基础命中点之后，结果（时刻或冲突）真正不同的点。
  // 若上游富余时间吸收了变化，下游时刻可能保持不变——这正是“局部”的意义。
  const actuallyChanged = [];
  for (let i = firstBaseHit; i < rescheduled.length; i++) {
    const it = rescheduled[i];
    const sig = JSON.stringify({ s: it.planned_start || null, e: it.planned_end || null, c: it.conflict || null });
    const oldSig = JSON.stringify(before[i]);
    if (sig !== oldSig) actuallyChanged.push(i);
  }
  const lastChanged = actuallyChanged.length ? actuallyChanged[actuallyChanged.length - 1] : firstBaseHit - 1;
  const out = finalize(world, rescheduled, base, 'local');
  out.repair = {
    changed: actuallyChanged.length > 0,
    first_base_hit: firstBaseHit,
    affected_indexes: actuallyChanged,
    candidate_indexes: copy.map((_, i) => i).filter((i) => i >= firstBaseHit),
    reused_indexes: copy.map((_, i) => i).filter((i) => i < firstBaseHit),
    absorbed: actuallyChanged.length === 0,
    trigger: changes,
  };
  return out;
}

// 依赖指纹：一个点的“计划时刻”依赖哪些基础数据
function pureCtx(ctx) {
  return { date: ctx.date, startPlaceId: ctx.startPlaceId };
}
export function dependencyOf(world, items, index, rawCtx) {
  const ctx = pureCtx(rawCtx);
  const it = items[index];
  const fac = world.facilities.find((f) => f.id === it.facility_id);
  const deps = {
    date: ctx.date,
    startPlace: ctx.startPlaceId,
    facility: it.facility_id,
    facilityVersion: fac ? fac.data_updated_at : null,
    windowsOf: it.facility_id,
    windowsVersion: worldWindowVersion(world, it.facility_id),
    maintenanceIds: worldMaintenanceIds(world, fac, ctx.date),
    duration: it.duration_min || (fac ? DEFAULT_DURATIONS[fac.kind] : DEFAULT_DURATIONS.other),
    // 注意：依赖指纹只含“排程基础数据”，不含 locked/planned_start 等用户操作状态，
    // 否则锁定动作会被误判为基础数据变更而触发整条链重排。
    incomingEdge: null,
  };
  let fromPlace = ctx.startPlaceId;
  if (index > 0) {
    const prevFac = world.facilities.find((f) => f.id === items[index - 1].facility_id);
    fromPlace = prevFac ? prevFac.place_id : null;
  }
  if (fac && fromPlace) {
    const w = walkBetween(world.graph, fromPlace, fac.place_id);
    deps.incomingEdge = { from: fromPlace, to: fac.place_id, sec: w.sec, path: w.path };
  }
  return { deps, hash: fingerprint(deps) };
}

// ---------------------------------------------------------------------------

function scheduleChain(world, items, fromIdx, initialCursor, ctx) {
  let cursor = initialCursor;
  for (let i = fromIdx; i < items.length; i++) {
    const it = items[i];
    const fac = world.facilities.find((f) => f.id === it.facility_id);
    if (!fac) {
      it.planned_start = null; it.planned_end = null;
      it.conflict = { conflicts: [{ type: 'facility_gone', message: '施設が統合・削除されています（ロックは保持）' }] };
      it.dep_hash = fingerprint({ gone: it.facility_id });
      continue;
    }
    const duration = it.duration_min || DEFAULT_DURATIONS[fac.kind];
    const avail = availabilityOnDate(world, it.facility_id, ctx.date);

    // —— 手工锁定点：时间不动，只解释冲突 ——
    if (it.locked && it.planned_start) {
      const start = new Date(it.planned_start);
      const end = it.planned_end ? new Date(it.planned_end) : new Date(start.getTime() + duration * 60000);
      const conflicts = conflictsForVisit(avail, start, end);
      it.planned_start = start.toISOString();
      it.planned_end = end.toISOString();
      it.conflict = conflicts.length ? { locked: true, conflicts, available: avail.open_ranges } : null;
      it.availability = summarizeAvail(avail);
      it.dep_hash = dependencyOf(world, items, i, ctx).hash;
      cursor = { at: end, placeId: fac.place_id };
      continue;
    }

    // —— 非锁定点：在可行时窗内贪心取“最早能完整放入”的区间 ——
    let earliest = dayStart(ctx.date, 540);
    if (cursor?.at) earliest = new Date(cursor.at.getTime());
    let fromPlace = ctx.startPlaceId;
    if (cursor?.placeId) fromPlace = cursor.placeId;
    const walk = walkBetween(world.graph, fromPlace, fac.place_id);
    const readyAt = walk.sec != null && cursor?.at
      ? new Date(cursor.at.getTime() + walk.sec * 1000)
      : earliest;

    const fit = pickSlot(avail.open_ranges, readyAt, duration);
    if (fit) {
      it.planned_start = fit.start.toISOString();
      it.planned_end = fit.end.toISOString();
      it.conflict = null;
      it.availability = summarizeAvail(avail);
      cursor = { at: fit.end, placeId: fac.place_id };
    } else {
      it.planned_start = null; it.planned_end = null;
      it.conflict = {
        conflicts: [{
          type: 'no_feasible_slot',
          message: avail.closed_reason
            ? `この日は利用できません（${avail.closed_reason === 'date_closed' ? '臨時休業' : avail.closed_reason === 'maintenance' ? '点検・メンテナンス' : '営業時窓なし'}）`
            : '当日の残り時間に入る時窓がありません',
          available: avail.open_ranges,
        }],
      };
      it.availability = summarizeAvail(avail);
      // 不可排入不移动游标，后续点仍从前一个成功点继续
    }
    it.walk_from_previous_sec = walk.sec;
    it.dep_hash = dependencyOf(world, items, i, ctx).hash;
  }
  return items;
}

function pickSlot(openRanges, earliest, durationMin) {
  for (const r of openRanges) {
    const start = r.start > earliest ? r.start : earliest;
    const end = new Date(start.getTime() + durationMin * 60000);
    if (end <= r.end) return { start, end };
  }
  return null;
}

function findFirstAffected(world, items, rawCtx, changes) {
  const ctx = pureCtx(rawCtx); // 指纹只用纯排程上下文，graph/computedAt 不参与
  const cFac = new Set(changes.facilities || []);
  const cWin = new Set(changes.windows || []);
  const cMaint = new Set(changes.maintenance || []);
  const cEdges = new Set(changes.edges || []);
  const cPlaces = new Set(changes.places || []);
  const cUserEdits = new Set(changes.userEdits || []);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const { deps, hash } = dependencyOf(world, items, i, ctx);
    // 0) 用户编辑（锁定/解锁/改锁定时刻/新增点）：从该点起重排
    if (cUserEdits.has(i)) return i;
    // 1) 直接数据变更
    if (cFac.has(it.facility_id)) return i;
    if (cWin.has(it.facility_id)) return i;
    if (cPlaces.has(placeOf(world, it.facility_id))) return i;
    // 2) 维护记录命中（指纹里带的维护 id 集合与变更集合相交）
    if (deps.maintenanceIds.some((m) => cMaint.has(m))) return i;
    // 3) 入边变更：依赖的任一路径边被改
    if (deps.incomingEdge?.path?.some((eid) => cEdges.has(eid))) return i;
    // 4) 指纹变化兜底（时窗内容/版本更新但调用方没传明细）
    if (it.dep_hash && it.dep_hash !== hash) return i;
  }
  return -1;
}

function finalize(world, items, ctx, mode) {
  // 每个点附带解释信息（供 UI 展示过滤原因/冲突）
  for (let i = 0; i < items.length; i++) {
    items[i].place_id = placeOf(world, items[i].facility_id);
  }
  return {
    mode,
    date: ctx.date,
    start_place: ctx.startPlaceId,
    computed_at: ctx.computedAt,
    items,
    has_conflicts: items.some((it) => it.conflict),
    locked_preserved: items.filter((it) => it.locked).map((it) => ({
      facility_id: it.facility_id, planned_start: it.planned_start,
      in_conflict: !!(it.conflict && it.locked),
    })),
  };
}

// 一致性自检：未受影响的点，full 与 local 的时刻必须一致
export function assertConsistent(fullPlan, localPlan, reusedIndexes) {
  const diffs = [];
  for (const i of reusedIndexes) {
    const a = fullPlan.items[i]; const b = localPlan.items[i];
    if (!a || !b) continue;
    if ((a.planned_start || null) !== (b.planned_start || null)
      || (a.planned_end || null) !== (b.planned_end || null)) {
      diffs.push({ index: i, full: [a.planned_start, a.planned_end], local: [b.planned_start, b.planned_end] });
    }
  }
  return { consistent: diffs.length === 0, diffs };
}

// 可访问时间段组合 API：给定候选设施，返回各自时段 + 最早可行的串联方案
export function combineSlots(world, facilityIds, ctx) {
  const slots = facilityIds.map((fid) => {
    const a = availabilityOnDate(world, fid, ctx.date);
    const fac = world.facilities.find((f) => f.id === fid);
    return {
      facility_id: fid,
      place_id: fac ? fac.place_id : null,
      open: a.open,
      ranges: a.open_ranges.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
      maintenance: a.maintenance.map((m) => ({ id: m.id, title: m.title, all_day: m.all_day })),
      closed_reason: a.closed_reason,
    };
  });
  const pseudoItems = facilityIds.map((facility_id) => ({ facility_id, locked: false }));
  const plan = fullRecompute(world, pseudoItems, ctx);
  return { date: ctx.date, slots, earliest_combo: plan.items };
}

function summarizeAvail(avail) {
  return {
    open: avail.open,
    ranges: avail.open_ranges.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
    partial: avail.maintenance.length > 0 && avail.open_ranges.length > 0,
    closed_reason: avail.closed_reason,
  };
}

function placeOf(world, facilityId) {
  const f = world.facilities.find((x) => x.id === facilityId);
  return f ? f.place_id : null;
}
function dayStart(dateStr, min) { return atMinute(dateStr, min); }
function worldWindowVersion(world, facilityId) {
  const ws = world.windows.filter((w) => w.facility_id === facilityId)
    .map((w) => `${w.dow}:${w.open_min}-${w.close_min}`).sort();
  const ds = (world.dateWindows || []).filter((d) => d.facility_id === facilityId)
    .map((d) => `${d.cal_date}:${d.closed ? 'X' : `${d.open_min}-${d.close_min}`}`).sort();
  return fingerprint({ ws, ds });
}
function worldMaintenanceIds(world, fac, date) {
  if (!fac) return [];
  return world.maintenance
    .filter((m) => (m.facility_id === fac.id || m.place_id === fac.place_id)
      && m.status !== 'done' && m.status !== 'cancelled')
    .map((m) => m.id);
}
