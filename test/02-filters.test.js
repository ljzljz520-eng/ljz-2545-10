const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api } = require('./helpers');

before(async () => { await setup(); });
after(async () => { await teardown(); });

test('部分泡池跨日检修，不连坐同馆餐饮；过滤原因完整', async () => {
  // 2026-10-06 周二 12:00 JST = 03:00Z；露天桧木池 10-05 20:00~10-07 09:00 检修中
  const { body } = await api('/api/places?food=1&at=2026-10-06T03:00:00Z');
  const ym = body.included.find(p => p.name === '汤本馆');
  assert.ok(ym, '汤上食堂开着，汤本馆必须仍然出现在餐饮筛选结果里（不连坐）');
  const pool11 = ym.facilities.find(f => f.name === '露天桧木池');
  assert.ok(pool11.maintenance.length, '露天桧木池应标注检修');
  const caf = ym.facilities.find(f => f.name === '汤上食堂');
  assert.strictEqual(caf.maintenance.length, 0);
  // 过滤项要带原因
  const merged = body.excluded.find(e => e.place.name.includes('樱见'));
  assert.ok(merged.reasons.some(r => r.code === 'merged'));
});

test('同一场馆在餐饮未开门时说明“稍后开放”，而不是静默消失语义错误', async () => {
  // 周二 11:00 JST：汤上食堂 11:30 才开
  const { body } = await api('/api/places?food=1&at=2026-10-06T02:00:00Z');
  const ym = body.excluded.find(e => e.place.name === '汤本馆');
  assert.ok(ym, '未开门时段被排除');
  assert.match(ym.reasons[0].message, /11:30/);
});

test('住宿/餐饮/亲子设施三种筛选按设施维度生效', async () => {
  const stay = await api('/api/places?stay=1');
  assert.deepStrictEqual(stay.body.included.map(p => p.name), ['锦宿']);
  const family = await api('/api/places?family=1');
  assert.ok(family.body.included.some(p => p.name === '汤本馆'));
  assert.ok(family.body.included.some(p => p.name === '亲子馆 ぽかぽか'));
});

test('步行距离阈值按出发点过滤并给出距离与太远原因', async () => {
  const { body } = await api('/api/places?walkMeters=200&originLat=36.12210&originLng=137.68050');
  const names = body.included.map(p => p.name);
  assert.ok(names.includes('足汤公园'));
  assert.ok(!names.includes('锦宿'));
  const far = body.excluded.find(e => e.place.name === '锦宿');
  assert.ok(far.reasons.some(r => r.code === 'too_far' && /超过步行阈值/.test(r.message)));
});

test('维护设施在地图时刻不可用，但兄弟泡池可用', async () => {
  // 只查浴场类：周二12:00，露天检修、内汤开
  const { body } = await api('/api/places?at=2026-10-06T03:00:00Z');
  const ym = body.included.find(p => p.name === '汤本馆');
  assert.ok(ym, '至少内汤大池开着，场馆不应消失');
});

test('缺少出发点的步行筛选报 400', async () => {
  const r = await api('/api/places?walkMeters=500');
  assert.strictEqual(r.status, 400);
});
