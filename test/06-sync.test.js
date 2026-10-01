const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api } = require('./helpers');

before(async () => { await setup(); });
after(async () => { await teardown(); });

async function freshTrip() {
  const r = await api('/api/itineraries', { method: 'POST', body: { title: '双设备', device_id: 'setup' } });
  return Number(r.body.id);
}
const addOp = (id, device, base, place, facility) =>
  api(`/api/itineraries/${id}/edits`, { method: 'POST',
    body: { device_id: device, base_version: base, op: { type: 'add', place_id: place, facility_id: facility } } });

test('设备 A 提交成功后版本递增；设备 B 带旧基线提交得到 409 且不覆盖', async () => {
  const id = await freshTrip();
  const a = await addOp(id, 'device-A', 1, 5, 50);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.applied, true);
  assert.strictEqual(a.body.server_version, 2);
  const b = await addOp(id, 'device-B', 1, 4, 40);
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.body.conflict, true);
  assert.match(b.body.message, /v2/);
  // B 的编辑保留待处理
  const hist = await api(`/api/itineraries/${id}/edits`);
  const edits = hist.body.edits;
  assert.strictEqual(edits[0].applied, true);
  assert.strictEqual(edits[1].applied, false);
  assert.strictEqual(edits[1].conflict, true);
  // A 的添加生效；B 的没有
  const trip = await api(`/api/itineraries/${id}`);
  assert.strictEqual(trip.body.items.length, 1);
  assert.strictEqual(Number(trip.body.items[0].facility_id), 50);
});

test('设备 B 拉取新版本号后重试可成功', async () => {
  const id = await freshTrip();
  await addOp(id, 'device-A', 1, 5, 50);
  const retry = await addOp(id, 'device-B', 2, 4, 40);
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.applied, true);
  const trip = await api(`/api/itineraries/${id}`);
  assert.strictEqual(trip.body.items.length, 2);
});

test('lock/unlock 编辑通过版本控制', async () => {
  const id = await freshTrip();
  await addOp(id, 'device-A', 1, 5, 50);
  const item = (await api(`/api/itineraries/${id}`)).body.items[0].id;
  const lock = await api(`/api/itineraries/${id}/edits`, { method: 'POST',
    body: { device_id: 'device-A', base_version: 2, op: { type: 'lock', item_id: Number(item), lock_note: '手机锁定' } } });
  assert.strictEqual(lock.body.applied, true);
  const trip = await api(`/api/itineraries/${id}`);
  assert.strictEqual(trip.body.items[0].manual_lock, true);
});

test('缺少字段返回 400', async () => {
  const id = await freshTrip();
  const r = await api(`/api/itineraries/${id}/edits`, { method: 'POST', body: { device_id: 'x' } });
  assert.strictEqual(r.status, 400);
});
