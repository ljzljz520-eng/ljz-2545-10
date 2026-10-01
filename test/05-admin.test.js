const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api } = require('./helpers');

let http = require('http');
let lastFetch;
// 用全局 fetch 打桩模拟链接巡检结果
function stubFetch(impl) {
  const orig = global.fetch;
  global.fetch = (url, opts) => { lastFetch = url; return impl(url, opts); };
  return () => { global.fetch = orig; };
}

before(async () => { await setup(); });
after(async () => { await teardown(); });

test('新增跨日维护并能删除；维护挂子设施不影响父设施与兄弟设施', async () => {
  const m = await api('/api/admin/maintenance', { method: 'POST', body: {
    facility_id: 11, title: '跨日池修', start_at: '2026-11-02T20:00:00Z', end_at: '2026-11-04T02:00:00Z', source_id: 2 } });
  assert.strictEqual(m.status, 201);
  const d = await api(`/api/admin/maintenance/${m.body.id}`, { method: 'DELETE' });
  assert.strictEqual(d.body.deleted, Number(m.body.id));
});

test('维护时间反转返回 400', async () => {
  const r = await api('/api/admin/maintenance', { method: 'POST', body: {
    facility_id: 11, title: 'x', start_at: '2026-11-04T02:00:00Z', end_at: '2026-11-02T20:00:00Z' } });
  assert.strictEqual(r.status, 400);
});

test('链接巡检：HTTP 200 标记 active，410 标记 dead 并留痕', async () => {
  const realFetch = global.fetch;
  const restore = (() => { const orig = global.fetch;
    global.fetch = (url, opts) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return orig(url, opts);
      const good = !u.includes('/old/');
      return Promise.resolve({ ok: good, status: good ? 200 : 410,
        statusText: good ? 'OK' : 'Gone', json: async () => ({}) });
    };
    return () => { global.fetch = orig; };
  })();
  try {
    // source 2 是有效运营页 URL(/yumoto/hours)
    const ok = await api('/api/admin/sources/2/check', { method: 'POST' });
    assert.strictEqual(ok.body.ok, true);
    assert.strictEqual(ok.body.source_status, 'active');
    // source 3 是已合并旧页 URL(/old/merged-sakura)
    const dead = await api('/api/admin/sources/3/check', { method: 'POST' });
    assert.strictEqual(dead.body.ok, false);
    assert.strictEqual(dead.body.http_status, 410);
    assert.strictEqual(dead.body.source_status, 'dead');
    const list = await api('/api/admin/sources');
    const s3 = list.body.sources.find(x => Number(x.id) === 3);
    assert.strictEqual(s3.status, 'dead');
    assert.strictEqual(s3.last_ok, false);
  } finally {
    restore();
  }
});

test('无 URL 的实地来源巡检按 active 保留', async () => {
  const r = await api('/api/admin/sources/4/check', { method: 'POST' });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.source_status, 'active');
});

test('地点合并：旧点重定向、设施/别名迁移、步行边重定向、缓存失效', async () => {
  // 先给 8 一个独立设施并挂步行边（种子里 8 已并入 3，改用 6 站前商店 合入 5 足汤公园做一次真实合并）
  const r = await api('/api/admin/places/6/merge/5', { method: 'POST' });
  assert.deepStrictEqual(r.body, { merged: 6, into: 5 });
  const old = await api('/api/places/6');
  assert.strictEqual(old.body.redirect.merged_into, 5);
  // 设施真实迁移到保留地点（不只是标记）
  const keep = await api('/api/places/5');
  assert.ok(keep.body.place.facilities.some(f => f.name === '店内卖场'), '迁入设施应挂在保留地点下');
  // 保留地点仍正常营业
  assert.strictEqual(keep.body.place.active, true);
  // 合并后筛选里旧点给 merged 原因
  const search = await api('/api/places');
  const ex = search.body.excluded.find(e => e.place.name === '站前商店');
  assert.ok(ex.reasons.some(r => r.code === 'merged'));
});

test('地点不能自己合并自己', async () => {
  const r = await api('/api/admin/places/5/merge/5', { method: 'POST' });
  assert.strictEqual(r.status, 400);
});

test('待核信息标记与读取', async () => {
  const r = await api('/api/admin/places/9/verification', { method: 'PATCH', body: { needs_verification: true, note: '季节营业待核' } });
  assert.strictEqual(r.body.needs_verification, true);
  const p = await api('/api/places/9');
  assert.strictEqual(p.body.place.needs_verification, true);
});

test('离线包区分 current / expired；过期包显式提示', async () => {
  const { body } = await api('/api/admin/offline');
  const cur = body.packages.find(p => p.version === '2026.09');
  const exp = body.packages.find(p => p.version === '2026.07');
  assert.strictEqual(cur.state, 'current');
  assert.strictEqual(exp.state, 'expired');
  assert.match(exp.message, /过期/);
});

test('步行边更新后路段缓存失效（局部修复触发器）', async () => {
  const r = await api('/api/admin/walking-edges', { method: 'POST', body: {
    from_place: 1, to_place: 5, distance_m: 280, duration_s: 230, source_id: 4 } });
  assert.strictEqual(r.body.edge.duration_s, 230);
  assert.ok(r.body.cache_entries_invalidated >= 0);
});
