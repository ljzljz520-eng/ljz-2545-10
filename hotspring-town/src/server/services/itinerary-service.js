// 行程服务：编排引擎 + 持久化 + 锁定语义 + 双设备冲突
import * as repo from '../repo/repo.js';
import { buildWorld } from '../engine/filter.js';
import { fullRecompute, localRepair, assertConsistent } from '../engine/itinerary.js';
import { now } from '../util/time.js';

export async function buildCtx(itinerary) {
  return { date: itinerary.visit_date, startPlaceId: itinerary.start_place };
}

function toEngineItems(rows) {
  return rows.map((r) => ({
    id: r.id, facility_id: r.facility_id, facility_snapshot: r.facility_snapshot,
    locked: r.locked, locked_note: r.locked_note,
    planned_start: r.planned_start ? new Date(r.planned_start).toISOString() : null,
    planned_end: r.planned_end ? new Date(r.planned_end).toISOString() : null,
    conflict: r.conflict, dep_hash: r.dep_hash,
  }));
}

async function decorate(items) {
  for (const it of items) {
    const fac = await repo.getFacility(it.facility_id);
    it.facility = fac ? {
      id: fac.id, name: fac.name, kind: fac.kind, place_id: fac.place_id,
      family_friendly: fac.family_friendly,
    } : (it.facility_snapshot ? { name: it.facility_snapshot, missing: true } : { missing: true });
  }
  return items;
}

// 完整重算
export async function recompute(id, { deviceId, mode = 'full' } = {}) {
  const itinerary = await repo.getItinerary(id);
  if (!itinerary) return null;
  const world = buildWorld(await repo.loadWorld());
  const engineItems = toEngineItems(itinerary.items);
  const ctx = await buildCtx(itinerary);
  const plan = fullRecompute(world, engineItems, ctx);
  const saved = await persistPlan(itinerary, plan, { deviceId, kind: 'recompute', payload: { mode: 'full' } });
  await decorate(plan.items);
  return { itinerary_id: id, version: saved.version, ...stripMode(plan) };
}

// 局部修复：changes 指明变化的基础数据
export async function repair(id, changes, { deviceId } = {}) {
  const itinerary = await repo.getItinerary(id);
  if (!itinerary) return null;
  const world = buildWorld(await repo.loadWorld());
  const engineItems = toEngineItems(itinerary.items);
  const ctx = await buildCtx(itinerary);

  // 先完整重算一份做“一致性基准”，但不落库（用于校验未受影响点完全一致）
  const baseline = fullRecompute(world, engineItems.map((x) => ({ ...x })), ctx);
  const plan = localRepair(world, engineItems.map((x) => ({ ...x })), ctx, changes);
  const reused = plan.repair?.reused_indexes || [];
  const check = assertConsistent(baseline, plan, reused);
  // 另做全量校验：即使被列入“候选重排”，结果也必须与完整重算逐点一致
  const fullCheck = assertConsistent(baseline, plan, baseline.items.map((_, i) => i));

  const saved = await persistPlan(itinerary, plan, {
    deviceId, kind: 'repair',
    payload: { trigger: changes, consistency: check, repair: plan.repair },
  });
  await decorate(plan.items);
  return {
    itinerary_id: id, version: saved.version, ...stripMode(plan),
    consistency_check: check, full_equivalence: fullCheck, repair: plan.repair,
  };
}

// 增删点 / 重排 / 锁定（编辑后默认走局部修复：只动变化点之后）
export async function editItems(id, newItems, { deviceId, expectedVersion, action, lockChanges = [] }) {
  const itinerary = await repo.getItinerary(id);
  if (!itinerary) return { error: 'not_found', status: 404 };
  if (Number(itinerary.version) !== Number(expectedVersion)) {
    return { error: 'version_conflict', status: 409,
      currentVersion: itinerary.version,
      message: '別の端末で既に編集されています。最新版を取得して差分を確認してください。' };
  }
  const world = buildWorld(await repo.loadWorld());
  const ctx = await buildCtx(itinerary);

  // 合并：按位置沿用旧点（保留锚点时刻/dep_hash），再标记真正的用户编辑点
  const prevItems = itinerary.items;
  const userEditIdx = [];
  const merged = newItems.map((it, i) => {
    const prev = prevItems[i];
    const sameFacility = prev && prev.facility_id === it.facility_id;
    const locked = it.locked ?? prev?.locked ?? false;
    // 锁定时刻以客户端为准；非锁定点若设施未变则沿用旧时刻（作为重排锚点）
    let plannedStart = it.planned_start
      ? new Date(it.planned_start).toISOString()
      : (sameFacility && prev.planned_start ? new Date(prev.planned_start).toISOString() : null);
    let plannedEnd = it.planned_end
      ? new Date(it.planned_end).toISOString()
      : (sameFacility && prev.planned_end ? new Date(prev.planned_end).toISOString() : null);
    if (it.locked === false && prev?.locked) {
      // 解锁：交给引擎重新贪心排程
      plannedStart = sameFacility && prev.planned_start ? new Date(prev.planned_start).toISOString() : null;
    }
    const lockToggled = prev && (!!it.locked !== !!prev.locked);
    const lockTimeChanged = locked && it.planned_start
      && (!prev?.planned_start || new Date(it.planned_start).getTime() !== new Date(prev.planned_start).getTime());
    const isNew = !sameFacility;
    if (isNew || lockToggled || lockTimeChanged) userEditIdx.push(i);
    return {
      ...it,
      id: it.id || prev?.id,
      locked,
      locked_note: it.locked_note ?? prev?.locked_note ?? null,
      planned_start: plannedStart,
      planned_end: plannedEnd,
      conflict: sameFacility ? (prev.conflict ?? null) : null,
      dep_hash: sameFacility ? (prev.dep_hash ?? null) : null,
    };
  });

  // 用户编辑点（锁定/解锁/改时刻/新增）从该位置起重排；
  // 删除/重排时，序列变化点之后的点可能换前置，交给指纹兜底检测。
  const changes = { userEdits: userEditIdx };
  const plan = localRepair(world, merged, ctx, changes);
  const saved = await persistPlan(itinerary, plan, {
    deviceId, expectedVersion: itinerary.version, kind: action || 'edit',
    payload: { lockChanges, repair: plan.repair },
  });
  if (!saved.ok) return { error: 'version_conflict', status: 409, currentVersion: saved.currentVersion };
  await decorate(plan.items);
  return { itinerary_id: id, version: saved.version, ...stripMode(plan), repair: plan.repair };
}

async function persistPlan(itinerary, plan, { deviceId, kind, payload }) {
  const rows = [];
  for (const it of plan.items) {
    let snap = it.facility_snapshot;
    if (!snap) {
      const fac = await repo.getFacility(it.facility_id);
      snap = fac ? fac.name : it.facility?.name || null;
    }
    rows.push({
      id: it.id, facility_id: it.facility_id, facility_snapshot: snap,
      planned_start: it.planned_start, planned_end: it.planned_end,
      locked: it.locked, locked_note: it.locked_note, conflict: it.conflict,
      dep_hash: it.dep_hash,
    });
  }
  return repo.saveItineraryPlan(itinerary.id, rows, {
    deviceId, expectedVersion: itinerary.version, kind, payload,
  });
}
function stripMode(plan) {
  const { items, ...rest } = plan;
  return { ...rest, items };
}
