const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api } = require('./helpers');
let segments, pool;
before(async () => {
  await setup();
  segments = require('../src/services/segments');
  pool = require('../src/db/pool');
  await segments.invalidateAll();
});
after(async () => { await teardown(); });

test('实测步行边优先于直线估算，且结果被缓存', async () => {
  const s1 = await segments.getSegment(1, 3); // 种子实测 96s
  assert.strictEqual(s1.source, 'measured');
  assert.strictEqual(s1.duration_s, 96);
  assert.strictEqual(s1.cache_hit, false);
  const s2 = await segments.getSegment(1, 3);
  assert.strictEqual(s2.cache_hit, true);
  assert.strictEqual(s2.duration_s, 96);
});

test('无实测边时回退 haversine，耗时随距离/步速确定', async () => {
  const s = await segments.getSegment(2, 4);
  assert.strictEqual(s.source, 'haversine');
  const expect = Math.round(s.distance_m / 1.25);
  assert.strictEqual(s.duration_s, expect);
});

test('步行边更新后缓存被置 invalid，下次读取拿到新耗时（新鲜度一致）；方向相关', async () => {
  // 两方向都有实测边但耗时不同（上下坡/绕行），证明按方向取值
  const rev = await segments.getSegment(5, 1);
  assert.strictEqual(rev.source, 'measured');
  assert.strictEqual(rev.duration_s, 215);
  const before = await segments.getSegment(1, 5);
  assert.strictEqual(before.source, 'measured');
  assert.strictEqual(before.duration_s, 220);
  await api('/api/admin/walking-edges', { method: 'POST', body: {
    from_place: 1, to_place: 5, distance_m: 300, duration_s: 400, source_id: 4 } });
  // 旧缓存 invalid，不再被命中
  const after = await segments.getSegment(1, 5);
  assert.strictEqual(after.cache_hit, false);
  assert.strictEqual(after.source, 'measured');
  assert.strictEqual(after.duration_s, 400);
  const snap = await segments.freshnessSnapshot([after.cache_key]);
  assert.ok(snap.by_source[0]);
});

test('缓存过期(expires_at<=now)不被命中并自动重算', async () => {
  await segments.getSegment(3, 4);
  await pool.query(`UPDATE segment_cache SET expires_at=now()-interval '1 second' WHERE from_place=3 AND to_place=4`);
  const r = await segments.getSegment(3, 4);
  assert.strictEqual(r.cache_hit, false, '过期缓存必须视为不新鲜');
  assert.ok(new Date(r.expires_at) > new Date());
});

test('全量重算与局部修复共用同一路段缓存答案（缓存层一致性）', async () => {
  const a = await segments.getSegment(1, 7);
  const b = await segments.getSegment(1, 7);
  assert.strictEqual(a.duration_s, b.duration_s);
  assert.strictEqual(a.source, b.source);
});
