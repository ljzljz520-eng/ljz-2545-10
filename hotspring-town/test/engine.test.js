import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, dijkstra, shortestPaths, walkBetween } from '../src/server/engine/walking.js';
import { availabilityOnDate, windowsOnDate, maintenanceOnDate } from '../src/server/engine/availability.js';
import { fullRecompute, localRepair, assertConsistent, dependencyOf, combineSlots } from '../src/server/engine/itinerary.js';
import { filterPlaces, buildWorld, expandRecommendations } from '../src/server/engine/filter.js';
import { makeWorld, SUN } from './helpers.js';

test('步行网络：多源最短路径按路网耗时而非直线', () => {
  const w = makeWorld();
  const d = dijkstra(w.graph, 'p0');
  assert.equal(d.get('p1'), 300);
  assert.equal(d.get('p2'), 900); // 300+600
  const sp = shortestPaths(w.graph, 'p0');
  assert.deepEqual(sp.get('p2').path, ['e1', 'e2']);
  assert.equal(walkBetween(w.graph, 'p2', 'p0').sec, 900); // 无向
});

test('跨夜时窗：close>=1440 落在次日', async () => {
  const w = makeWorld();
  w.windows.push({ id: 'wx', facility_id: 'f_bath', dow: 0, open_min: 1200, close_min: 1500 });
  const win = windowsOnDate('f_bath', w.windows, [], SUN);
  assert.equal(win.windows.length, 2);
  const { atMinute } = await import('../src/server/util/time.js');
  const late = win.windows.find((x) => x.end.getTime() > atMinute(SUN, 1440).getTime());
  assert.ok(late, '营业结束应超过当日24:00（跨夜）');
});

test('维护裁剪营业区间：facility 级维护不影响同馆其他设施', () => {
  const w = makeWorld();
  w.maintenance.push({
    id: 'm1', facility_id: 'f_bath', place_id: null, title: '大浴池检修',
    start_at: '2026-10-04T10:00:00+09:00', end_at: '2026-10-04T18:00:00+09:00',
    status: 'scheduled',
  });
  const bath = availabilityOnDate(w, 'f_bath', SUN);
  assert.equal(bath.open, true);                 // 18点后仍可用
  assert.equal(bath.open_ranges.length, 1);      // [15,23]-[10,18]=[18,23]
  assert.equal(bath.open_ranges[0].end.getUTCHours(), 14); // 23:00 JST = 14:00 UTC
  const food = availabilityOnDate(w, 'f_food', SUN);
  assert.equal(food.open_ranges.length, 1);      // 餐饮不受影响
});

test('跨多日维护：中段全天关闭，结束日恢复', () => {
  const w = makeWorld();
  w.maintenance.push({
    id: 'm2', facility_id: 'f_bath', place_id: null, title: '跨日大修',
    start_at: '2026-10-05T22:00:00+09:00', end_at: '2026-10-07T20:00:00+09:00',
    status: 'scheduled',
  });
  assert.equal(maintenanceOnDate(w.maintenance, '2026-10-06', { facilityId: 'f_bath' })[0].all_day, true);
  const day7 = availabilityOnDate({ ...w, windows: w.windows.map((x) => x.id === 'w1' ? { ...x, dow: 3 } : x) }, 'f_bath', '2026-10-07');
  // 10-07 是周三 dow3；维护20:00 JST=11:00 UTC 结束，之后(15:00-23:00窗口)部分可用
  assert.ok(day7.open_ranges.some((r) => r.start.getUTCHours() >= 11));
});

test('日期覆盖 closed=true 优先于周时窗', () => {
  const w = makeWorld();
  w.dateWindows.push({ id: 'd1', facility_id: 'f_bath', cal_date: SUN, closed: true, note: '临时休' });
  const a = availabilityOnDate(w, 'f_bath', SUN);
  assert.equal(a.open, false);
  assert.equal(a.closed_reason, 'date_closed');
});

test('筛选：亲子+步行圈；一个泡池检修不隐藏场馆', () => {
  const w = makeWorld();
  w.maintenance.push({
    id: 'm3', facility_id: 'f_bath', place_id: null, title: '大浴池检修全天',
    start_at: `${SUN}T00:00:00+09:00`, end_at: `${SUN}T23:59:59+09:00`, status: 'scheduled',
  });
  const res = filterPlaces(buildWorld(w), { kinds: ['onsen'], familyOnly: true, originPlaceId: 'p0', maxWalkSec: 600, date: SUN });
  const p1 = res.matched.find((p) => p.id === 'p1');
  assert.ok(p1, '场馆仍显示');
  assert.equal(p1.partial_maintenance, true);
  const bath = p1.facilities.find((f) => f.id === 'f_bath');
  const kids = p1.facilities.find((f) => f.id === 'f_kids');
  assert.equal(bath.today_unavailable, true);
  assert.equal(kids.today_open, true);
});

test('筛选：步行超时给 too_far 过滤原因', () => {
  const w = makeWorld();
  const res = filterPlaces(buildWorld(w), { originPlaceId: 'p0', maxWalkSec: 400, date: SUN });
  assert.ok(res.hidden.find((h) => h.place_id === 'p2')?.reasons.some((r) => r.code === 'too_far'));
});

test('推荐展开：输出具体设施而非整馆，检修设施不进 actionable', () => {
  const w = makeWorld();
  w.maintenance.push({
    id: 'm4', facility_id: 'f_bath', place_id: null, title: '检修',
    start_at: `${SUN}T00:00:00+09:00`, end_at: `${SUN}T23:59:59+09:00`, status: 'scheduled',
  });
  const out = expandRecommendations(buildWorld(w), [{ key: 'k1', place_id: 'p1' }], SUN)[0];
  assert.ok(out.facility_options.length >= 2);
  assert.ok(!out.actionable_facility_ids.includes('f_bath'));
  assert.ok(out.actionable_facility_ids.includes('f_kids'));
});

test('排程：贪心使用最早可行时窗并计入步行耗时', () => {
  const w = makeWorld();
  const plan = fullRecompute(w, [{ facility_id: 'f_food' }, { facility_id: 'f_kids' }], { date: SUN, startPlaceId: 'p0' });
  // 起点到餐厅 900 秒(p0->p1->p2)，11:00 JST=02:00 UTC 开门
  const food = plan.items[0];
  assert.equal(food.planned_start, `${SUN}T02:00:00.000Z`);
  assert.equal(food.planned_end, `${SUN}T03:15:00.000Z`); // 75 分
  // 餐厅->亲子池 p2->p1 600秒；10:00JST=01:00 开门，10:15+10分到达 10:25，可放入
  const kids = plan.items[1];
  assert.equal(kids.planned_start, `${SUN}T03:25:00.000Z`); // 03:15+10分步行
});

test('锁定点：时窗改变后保留时刻并给冲突，不偷换', () => {
  const w = makeWorld();
  const base = { date: SUN, startPlaceId: 'p0' };
  const items = [{ facility_id: 'f_kids', locked: true, planned_start: `${SUN}T03:00:00.000Z`, planned_end: `${SUN}T04:00:00.000Z` }]; // 12:00-13:00 JST
  let plan = fullRecompute(w, items.map((x) => ({ ...x })), base);
  assert.equal(plan.items[0].conflict, null);
  // 时窗缩短为 08-09 点 JST
  const w2 = { ...w, windows: w.windows.map((x) => x.id === 'w2' ? { ...x, open_min: 480, close_min: 540 } : x) };
  const stored = plan.items.map((it) => ({ ...it }));
  const repair = localRepair(w2, stored, base, { windows: ['f_kids'] });
  const it = repair.items[0];
  assert.equal(it.locked, true);
  assert.equal(it.planned_start, `${SUN}T03:00:00.000Z`);
  assert.ok(it.conflict.conflicts.some((c) => c.type === 'outside_hours'));
});

test('完整重算与局部修复对未受影响点逐点一致', () => {
  const w = makeWorld();
  const base = { date: SUN, startPlaceId: 'p0' };
  const input = [{ facility_id: 'f_food' }, { facility_id: 'f_kids' }, { facility_id: 'f_bath' }];
  const pFull0 = fullRecompute(w, input.map((x) => ({ ...x })), base);
  const stored = pFull0.items.map((it) => ({ facility_id: it.facility_id, planned_start: it.planned_start, planned_end: it.planned_end, locked: false, dep_hash: it.dep_hash }));
  // 修改最后一个设施 f_bath 的时窗
  const w2 = { ...w, windows: w.windows.map((x) => x.id === 'w1' ? { ...x, open_min: 960, close_min: 1380 } : x) };
  const repair = localRepair(w2, stored.map((x) => ({ ...x })), base, { windows: ['f_bath'] });
  const baseline = fullRecompute(w2, stored.map((x) => ({ ...x })), base);
  assert.ok(repair.repair.affected_indexes.includes(2));
  assert.deepEqual(repair.repair.reused_indexes, [0, 1]);
  const chk = assertConsistent(baseline, repair, [0, 1, 2]);
  assert.equal(chk.consistent, true, JSON.stringify(chk.diffs));
});

test('无关数据变化不触发任何修复', () => {
  const w = makeWorld();
  const base = { date: SUN, startPlaceId: 'p0' };
  const p = fullRecompute(w, [{ facility_id: 'f_food' }, { facility_id: 'f_kids' }], base);
  const stored = p.items.map((it) => ({ facility_id: it.facility_id, planned_start: it.planned_start, planned_end: it.planned_end, locked: false, dep_hash: it.dep_hash }));
  const w2 = { ...w, maintenance: [...w.maintenance, { id: 'm9', facility_id: 'f_bath', place_id: null, title: 'x', start_at: '2026-11-01T00:00:00Z', end_at: '2026-11-02T00:00:00Z', status: 'scheduled' }] };
  const repair = localRepair(w2, stored, base, { maintenance: ['m9'] });
  assert.equal(repair.repair.changed, false);
  assert.deepEqual(repair.repair.reused_indexes, [0, 1]);
});

test('依赖指纹稳定且对时窗变化敏感', () => {
  const w = makeWorld();
  const base = { date: SUN, startPlaceId: 'p0' };
  const items = [{ facility_id: 'f_kids' }];
  const h1 = dependencyOf(w, items, 0, base).hash;
  const h2 = dependencyOf(w, items, 0, { ...base, graph: w.graph, computedAt: 'noise' }).hash;
  assert.equal(h1, h2); // graph/computedAt 不参与指纹
  const w2 = { ...w, windows: w.windows.map((x) => x.id === 'w2' ? { ...x, close_min: 1000 } : x) };
  const h3 = dependencyOf(w2, items, 0, base).hash;
  assert.notEqual(h1, h3);
});

test('slots 组合：列出可访问时段并给最早串联', () => {
  const w = makeWorld();
  const out = combineSlots(w, ['f_food', 'f_kids'], { date: SUN, startPlaceId: 'p0' });
  assert.equal(out.slots.length, 2);
  assert.ok(out.slots.every((s) => Array.isArray(s.ranges) && s.ranges.length >= 1));
  assert.equal(out.earliest_combo.length, 2);
});
