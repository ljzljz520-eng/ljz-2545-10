const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api, dailyHours } = require('./helpers');

before(async () => { await setup(); });
after(async () => { await teardown(); });

async function newItinerary(title) {
  const r = await api('/api/itineraries', { method: 'POST', body: { title, device_id: 't' } });
  return r.body.id;
}
async function addItem(id, version, place_id, facility_id) {
  return api(`/api/itineraries/${id}/edits`, { method: 'POST',
    body: { device_id: 't', base_version: version, op: { type: 'add', place_id, facility_id } } });
}
const sig = (r) => r.body.items.map(i => `${i.facility_id}@${i.arrive_at}`).join('|');

test('完整重算给出可行时窗：开放窗+步行路段+停留时长', async () => {
  const id = await newItinerary('行程A');
  await addItem(id, 1, 1, 12);   // 内汤大池
  await addItem(id, 2, 7, 70);   // 亲子戏水厅
  await addItem(id, 3, 3, 30);   // 峰味堂食区
  const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST',
    body: { startAt: '2026-10-08T00:30:00Z' } }); // 周四 09:30 JST
  assert.strictEqual(r.body.conflicts.length, 0);
  const [a, b, c] = r.body.items;
  assert.strictEqual(a.arrive_at, '2026-10-08T00:30:00.000Z'); // 09:30
  assert.strictEqual(a.depart_at, '2026-10-08T01:00:00.000Z'); // 09:30+30min(1800s)
  // 步行1->7 用 haversine(无实测边) +1min入口
  assert.ok(new Date(b.arrive_at) > new Date(a.depart_at));
  assert.ok(new Date(c.arrive_at) >= new Date(b.depart_at));
});

test('完整重算与按依赖局部修复结果完全一致', async () => {
  const id = await newItinerary('一致性');
  await addItem(id, 1, 1, 12);
  await addItem(id, 2, 3, 30);
  await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { startAt: '2026-10-08T00:30:00Z' } });
  const full = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { mode: 'full' } });
  const partial = await api(`/api/itineraries/${id}/recompute`, { method: 'POST',
    body: { mode: 'partial', trigger: { facilityIds: [12, 30] } } });
  assert.strictEqual(partial.body.start_index, 0);
  assert.strictEqual(sig(full), sig(partial), '两种修复策略必须产出同一时间计划');
});

test('局部修复只重排受影响后缀；未涉及的前置锁定点不动', async () => {
  const id = await newItinerary('局部');
  await addItem(id, 1, 1, 12);
  await addItem(id, 2, 7, 70);
  await addItem(id, 3, 3, 30);
  await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { startAt: '2026-10-08T00:30:00Z' } });
  const before = await api(`/api/itineraries/${id}`);
  const firstArrive = before.body.items[0].arrive_at;
  // 触发只影响第 3 个点(facility 30)
  const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST',
    body: { mode: 'partial', trigger: { facilityIds: [30] } } });
  assert.strictEqual(r.body.start_index, 2, '局部修复应从下标2开始');
  const after = await api(`/api/itineraries/${id}`);
  assert.strictEqual(after.body.items[0].arrive_at, firstArrive, '前缀点时间不应变化');
});

test('手工锁定后开放时间改变：锁定保留并同时解释闭馆与时表变化，绝不偷偷换点', async () => {
  const id = await newItinerary('锁定');
  await addItem(id, 1, 1, 10); // 大浴场
  await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { startAt: '2026-10-08T01:00:00Z' } });
  let cur = await api(`/api/itineraries/${id}`);
  const itemId = cur.body.items[0].id;
  const lockedArrive = cur.body.items[0].arrive_at;
  const lock = await api(`/api/itineraries/${id}/items/${itemId}/lock`, { method: 'POST', body: { lock_note: '就要这个时间' } });
  assert.ok(lock.body.locked_window.fingerprint);
  // 改开放时间：平日推迟到 13:00
  const hours = dailyHours('13:00', '22:00');
  hours[5].close_time = '23:00'; hours[6] = { day_of_week: 6, open_time: '10:00', close_time: '23:00' };
  hours[0] = { day_of_week: 0, open_time: '10:00', close_time: '22:00' };
  await api('/api/admin/opening-hours/facility/10', { method: 'POST', body: { source_id: 2, hours } });
  const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: {} });
  const item = r.body.items[0];
  assert.strictEqual(item.arrive_at, lockedArrive, '锁定点时间一个毫秒都不能变');
  assert.strictEqual(item.manual_lock, true);
  const codes = r.body.conflicts.map(c => c.code);
  assert.ok(codes.includes('locked_closed_conflict'));
  assert.ok(codes.includes('hours_changed_after_lock'));
  const hc = r.body.conflicts.find(c => c.code === 'hours_changed_after_lock');
  assert.ok(JSON.stringify(hc.locked_hours).includes('10:00'));
  assert.ok(JSON.stringify(hc.current_hours).includes('13:00'));
  // 系统没有把该点换成别的设施
  assert.strictEqual(item.facility_id, 10);
});

test('锁定点撞上新增维护：保留并报 locked_maintenance_conflict', async () => {
  const id = await newItinerary('锁定-检修');
  await addItem(id, 1, 1, 12);
  await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { startAt: '2026-10-08T01:00:00Z' } });
  const itemId = (await api(`/api/itineraries/${id}`)).body.items[0].id;
  await api(`/api/itineraries/${id}/items/${itemId}/lock`, { method: 'POST', body: {} });
  // 周四 10:00-12:00 JST 给内汤池加检修
  await api('/api/admin/maintenance', { method: 'POST', body: {
    facility_id: 12, title: '临时检修', start_at: '2026-10-08T01:00:00Z', end_at: '2026-10-08T03:00:00Z', source_id: 2 } });
  const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: {} });
  assert.strictEqual(r.body.items[0].facility_id, 12);
  assert.ok(r.body.conflicts.some(c => c.code === 'locked_maintenance_conflict'));
});

test('无可行时窗时保留点并报 no_feasible_slot，不静默删除或替换', async () => {
  const id = await newItinerary('不可行');
  await addItem(id, 1, 9, 90); // 夜鸣屋台 22:00-01:00
  const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: { startAt: '2026-10-08T01:00:00Z' } });
  // 09:00 JST 起 12h 内屋台不开
  assert.ok(r.body.conflicts.some(c => c.code === 'no_feasible_slot'));
  assert.strictEqual(r.body.items.length, 1);
  assert.strictEqual(r.body.items[0].facility_id, 90);
});
