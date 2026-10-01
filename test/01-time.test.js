const { test } = require('node:test');
const assert = require('node:assert');
const { openIntervals, feasibility, earliestSlot } = require('../src/util/time');

const hours = (dow, o, c, x = false) => ({ day_of_week: dow, open_time: o, close_time: c, crosses_midnight: x });
const t = (s) => new Date(s);

test('普通时窗：营业前判定闭馆，营业中放行', () => {
  const rows = [hours(2, '11:30', '21:00')]; // 周二
  assert.strictEqual(feasibility(rows, [], t('2026-10-06T02:00:00Z'), t('2026-10-06T03:00:00Z')).code, 'closed'); // 11:00 JST
  assert.strictEqual(feasibility(rows, [], t('2026-10-06T02:30:00Z'), t('2026-10-06T03:30:00Z')), null);       // 11:30-12:30
  assert.strictEqual(feasibility(rows, [], t('2026-10-06T11:30:00Z'), t('2026-10-06T12:10:00Z')).code, 'closed'); // 20:30-21:10 越界
});

test('跨日时窗：22:00-次日01:00', () => {
  const rows = [hours(5, '22:00', '01:00', true)];
  assert.strictEqual(feasibility(rows, [], t('2026-10-09T13:00:00Z'), t('2026-10-09T13:30:00Z')), null); // 周五22:00
  assert.strictEqual(feasibility(rows, [], t('2026-10-09T15:30:00Z'), t('2026-10-09T16:30:00Z')).code, 'closed'); // 周六00:30-01:30 越界
  assert.strictEqual(feasibility(rows, [], t('2026-10-09T16:30:00Z'), t('2026-10-09T16:40:00Z')).code, 'closed'); // 01:30 已关
  const iv = openIntervals(rows, t('2026-10-09T13:00:00Z'), t('2026-10-09T16:00:00Z'));
  assert.strictEqual(iv.length, 1);
  assert.strictEqual(iv[0].end.getTime() - iv[0].start.getTime(), 3 * 3600_000); // 22:00-01:00
});

test('维护打断时窗；earliestSlot 跳过检修', () => {
  const rows = [hours(2, '09:00', '21:00')];
  const maint = [{ title: '检修', start_at: '2026-10-06T03:00:00Z', end_at: '2026-10-06T05:00:00Z' }]; // 12:00-14:00 JST
  assert.strictEqual(feasibility(rows, maint, t('2026-10-06T03:30:00Z'), t('2026-10-06T04:00:00Z')).code, 'maintenance');
  const slot = earliestSlot(rows, maint, t('2026-10-06T02:00:00Z'), t('2026-10-06T15:00:00Z'), 3600_000);
  assert.strictEqual(slot.start.toISOString(), '2026-10-06T05:00:00.000Z'); // 14:00 JST 才能开始
});

test('跨日维护与跨日营业交集正确', () => {
  // 客房 15:00-次日10:00；维护 周三18:00~周四09:00
  const rows = [hours(3, '15:00', '10:00', true)];
  const maint = [{ title: '楼层整修', start_at: '2026-10-07T09:00:00Z', end_at: '2026-10-08T00:00:00Z' }];
  // 周三 19:00 JST = 10:00 UTC 在维护内
  assert.strictEqual(feasibility(rows, maint, t('2026-10-07T10:00:00Z'), t('2026-10-07T11:00:00Z')).code, 'maintenance');
  // 周三 16:00 JST = 07:00 UTC 维护前，正常入住时段
  assert.strictEqual(feasibility(rows, [], t('2026-10-07T07:00:00Z'), t('2026-10-07T08:00:00Z')), null);
});
