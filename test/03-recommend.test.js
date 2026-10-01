const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, teardown, api } = require('./helpers');

before(async () => { await setup(); });
after(async () => { await teardown(); });

test('推荐条目展开到具体设施，而非只给场馆', async () => {
  const { body } = await api('/api/recommend?theme=family_foam');
  assert.strictEqual(body.theme.key, 'family_foam');
  assert.ok(body.items.length >= 2);
  for (const it of body.items) {
    assert.ok(it.facility_id, '每条都必须指向具体设施');
    assert.ok(it.facility_name);
    assert.ok(it.why, '每条都要有“为什么推荐这个设施”');
  }
  const play = body.items.find(i => i.facility_kind === 'play_room');
  assert.ok(play, '亲子戏水厅作为具体设施出现');
  assert.strictEqual(play.place_needs_verification, true);
});

test('检修中的泡池在主题推荐的时刻校验里标不可用并说明，餐饮条目仍可推荐', async () => {
  // 晨雾逐汤：内汤->足汤->食堂。取检修日 12:00（足汤/食堂应可用）
  const { body } = await api('/api/recommend?theme=morning_mist&at=2026-10-06T03:00:00Z');
  const food = body.items.find(i => i.facility_name === '汤上食堂');
  assert.ok(food.status_at_time.available, '泡池检修不影响同馆餐饮被推荐');
});

test('泉质条目附来源与免责声明；无医疗功效措辞', async () => {
  const { body } = await api('/api/places/1');
  const sq = body.place.springs[0];
  assert.ok(sq.source);
  assert.match(sq.description, /观测性描述/);
  assert.match(sq.disclaimer, /不构成医疗功效/);
  for (const bad of ['治る', '疗效', '治愈', '治疗']) {
    assert.ok(!sq.description.includes(bad));
  }
});

test('三个原创主题可列出', async () => {
  const { body } = await api('/api/recommend/themes');
  const keys = body.themes.map(t => t.key).sort();
  assert.deepStrictEqual(keys, ['family_foam', 'morning_mist', 'night_steam']);
});
