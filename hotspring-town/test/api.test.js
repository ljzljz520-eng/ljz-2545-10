import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.js';
import { setNow, resetNow } from '../src/server/util/time.js';

let server, base;
before(async () => {
  setNow('2026-10-01T04:00:00Z'); // 2026-10-01 13:00 JST
  const app = await createApp({ autoSeed: true });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { resetNow(); await new Promise((r) => server.close(r)); });

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/places 住宿筛选 + hidden 原因', async () => {
  const r = await api('GET', '/api/places?kinds=lodging&date=2026-10-04');
  assert.equal(r.status, 200);
  assert.ok(r.json.matched.every((p) => p.kind === 'lodging'));
  assert.ok(r.json.hidden.every((h) => h.reasons.length > 0));
});

test('部分检修：10-06 大露天不可用，餐饮住宿仍在', async () => {
  const r = await api('GET', '/api/places?kinds=onsen&date=2026-10-06');
  const kiri = r.json.matched.find((p) => p.id === 'p_kiri');
  assert.equal(kiri.facilities.find((f) => f.id === 'f_kiri_roten').today_open, false);
  assert.equal(kiri.facilities.find((f) => f.id === 'f_kiri_rest').today_open, true);
  assert.equal(kiri.facilities.find((f) => f.id === 'f_kiri_room').today_open, true);
});

test('泉质为描述性信息且附带医疗免责声明', async () => {
  const r = await api('GET', '/api/facilities/f_kiri_roten?date=2026-10-04');
  assert.ok(r.json.spring_quality.claims_descriptive.includes('alkaline'));
  assert.match(r.json.medical_disclaimer, /効能|治療/);
  const claims = JSON.stringify(r.json.spring_quality.claims_descriptive);
  assert.ok(!/cure|heal|treat/.test(claims));
});

test('行程全流程：创建→加点→锁定→改时窗→修复保留锁定并解释', async () => {
  let r = await api('POST', '/api/itineraries', { title: 't', visitDate: '2026-10-04', startPlaceId: 'p_station', deviceId: 'd1' });
  const id = r.json.id;
  r = await api('PUT', `/api/itineraries/${id}/items`, { expectedVersion: 1, action: 'add', deviceId: 'd1',
    items: [{ facility_id: 'f_yuge' }, { facility_id: 'f_momiji_iwa' }] });
  assert.equal(r.status, 200);
  const v2 = r.json.version;
  r = await api('PUT', `/api/itineraries/${id}/items`, { expectedVersion: v2, action: 'lock', deviceId: 'd1',
    items: [{ facility_id: 'f_yuge' }, { facility_id: 'f_momiji_iwa', locked: true,
      planned_start: '2026-10-04T07:00:00.000Z', planned_end: '2026-10-04T08:00:00.000Z' }] });
  assert.equal(r.json.items[1].conflict, null);
  const v3 = r.json.version;
  // 周日时窗 840-1200 -> 480-600
  await api('PUT', '/api/admin/windows/w47', { facilityId: 'f_momiji_iwa', dow: 0, openMin: 480, closeMin: 600 });
  r = await api('POST', `/api/itineraries/${id}/repair`, { deviceId: 'd1', changes: { windows: ['f_momiji_iwa'] } });
  const locked = r.json.items[1];
  assert.equal(locked.locked, true);
  assert.equal(locked.planned_start, '2026-10-04T07:00:00.000Z');
  assert.ok(locked.conflict.conflicts.some((c) => c.type === 'outside_hours'));
  assert.equal(r.json.full_equivalence.consistent, true);
});

test('双设备：版本冲突返回 409', async () => {
  let r = await api('POST', '/api/itineraries', { title: 'x', visitDate: '2026-10-04', deviceId: 'dA' });
  const id = r.json.id;
  await api('PUT', `/api/itineraries/${id}/items`, { expectedVersion: 1, deviceId: 'dA', action: 'add', items: [{ facility_id: 'f_yuge' }] });
  r = await api('PUT', `/api/itineraries/${id}/items`, { expectedVersion: 1, deviceId: 'dB', action: 'add', items: [{ facility_id: 'f_yuge' }, { facility_id: 'f_footbath' }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'version_conflict');
});

test('地点合并：重定向 + 设施迁移', async () => {
  const r = await api('POST', '/api/admin/places/merge', { keptId: 'p_dining', removedId: 'p_shop', reason: 'test' });
  assert.equal(r.json.ok, true);
  const d = await api('GET', '/api/places/p_shop');
  assert.equal(d.json.place.id, 'p_dining');
  assert.ok(d.json.facilities.some((f) => f.id === 'f_yuzuya'));
});

test('链接核查：404 标记 broken', async () => {
  const r = await api('POST', '/api/sources/check', { useNetwork: false });
  const momiji = r.json.results.find((x) => x.id === 's_momiji_oldpage');
  assert.equal(momiji.link_state, 'broken');
  assert.equal(momiji.http_status, 404);
});

test('离线包：过期显式横幅，未过期可用', async () => {
  let r = await api('POST', '/api/admin/offline/publish', { versionTag: 'exp', ttlDays: -10 });
  r = await api('GET', `/api/offline/${r.json.id}`);
  assert.equal(r.json.expired, true);
  assert.match(r.json.banner.title, /期限切れ/);
});

test('slots API 组合时间段', async () => {
  const r = await api('GET', '/api/slots?facilities=f_yuge,f_kiri_rest&date=2026-10-04');
  assert.equal(r.json.slots.length, 2);
  assert.equal(r.json.earliest_combo.length, 2);
});
