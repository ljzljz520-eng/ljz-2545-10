// 设施可用性：周时窗 + 日期覆盖 + 维护。
// 关键规则：
//  * date_windows 优先于周时窗（closed=true 表示当日休）
//  * close_min >= 1440 表示跨夜（营业到次日凌晨）
//  * 维护区间与「时窗实际起止区间（含跨夜延伸）」相交即不可用
//  * 跨多日的维护：只要 [visitDate 00:00, +1 00:00) 与维护区间相交就标注
import {
  dowOf, windowToRange, atMinute, localDate, addDays, overlap, now,
} from '../util/time.js';

// 计算某设施在 dateStr 当天“以当地日历定义”的营业区间列表（绝对时间）
export function windowsOnDate(facilityId, weeklyWindows, dateOverrides, dateStr) {
  const override = dateOverrides.find(
    (d) => d.facility_id === facilityId && d.cal_date === dateStr);
  if (override) {
    if (override.closed) {
      return { reason: 'date_closed', windows: [], note: override.note || null };
    }
    if (override.open_min != null && override.close_min != null) {
      return {
        reason: 'date_override',
        windows: [windowToRange(dateStr, override.open_min, override.close_min)],
        note: override.note || null,
      };
    }
  }
  const dow = dowOf(dateStr);
  const list = weeklyWindows
    .filter((w) => w.facility_id === facilityId && w.dow === dow)
    .map((w) => windowToRange(dateStr, w.open_min, w.close_min))
    .sort((a, b) => a.start - b.start);
  if (!list.length) return { reason: 'no_window', windows: [], note: null };
  return { reason: 'weekly', windows: list, note: null };
}

// 维护在给定日的影响：返回相交的维护记录（facility 级 + place 级）
export function maintenanceOnDate(maintList, dateStr, { facilityId = null, placeId = null } = {}) {
  const dayStart = atMinute(dateStr, 0);
  const dayEnd = atMinute(addDays(dateStr, 1), 0);
  return maintList.filter((m) => {
    if (m.status === 'done' || m.status === 'cancelled') return false;
    const onFacility = facilityId && m.facility_id === facilityId;
    const onPlace = placeId && m.place_id === placeId;
    if (!onFacility && !onPlace) return false;
    const ms = new Date(m.start_at); const me = new Date(m.end_at);
    return overlap(dayStart, dayEnd, ms, me);
  }).map((m) => {
    // 判断是否全天覆盖（便于 UI 直接显示「終日利用不可」）
    const ms = new Date(m.start_at); const me = new Date(m.end_at);
    const allDay = ms <= dayStart && me >= dayEnd;
    return { ...m, all_day: allDay };
  });
}

// 综合判断：当天有哪些可预约时段（区间减去维护交集）。
// 返回：
// { open: bool, openRanges:[{start,end}], blockedByMaintenance:[...],
//   closedReason: null|'date_closed'|'no_window', note }
export function availabilityOnDate(data, facilityId, dateStr) {
  const { windows, dateWindows, maintenance, facilities, places } = data;
  const fac = facilities.find((f) => f.id === facilityId);
  const place = fac && places.find((p) => p.id === fac.place_id);
  let win = windowsOnDate(facilityId, windows, dateWindows, dateStr);
  // 客房没有按日营业时窗：按「入住 15:00 〜 当日 24:00」给出可安排区间
  // （预订制语义与随到随用的时窗不同，但仍受维护裁剪）
  if (win.reason === 'no_window' && fac && fac.kind === 'room'
      && !dateWindows.some((d) => d.facility_id === facilityId && d.cal_date === dateStr && d.closed)) {
    win = { reason: 'room_checkin', windows: [windowToRange(dateStr, 900, 1440)], note: 'チェックイン枠（15:00〜24:00）' };
  }
  const maint = maintenanceOnDate(maintenance, dateStr, {
    facilityId, placeId: place ? place.id : null,
  });
  let openRanges = win.windows;
  if (maint.length) {
    openRanges = openRanges.flatMap((r) => subtractMaint(r, maint));
  }
  // 已经过去的时段（当“今天”时）裁掉，帮助推荐从可行时间排起
  if (dateStr === localDate(now())) {
    const t = now();
    openRanges = openRanges
      .map((r) => ({ start: r.start < t ? t : r.start, end: r.end }))
      .filter((r) => r.end > r.start);
  }
  return {
    facility_id: facilityId,
    date: dateStr,
    open: openRanges.length > 0,
    open_ranges: openRanges,
    weekly_source: win.reason,
    note: win.note,
    maintenance: maint,
    closed_reason: openRanges.length ? null : (win.reason === 'no_window' ? 'no_window'
      : win.reason === 'date_closed' ? 'date_closed' : 'maintenance'),
  };
}

function subtractMaint(range, maintList) {
  let pieces = [range];
  for (const m of maintList) {
    const ms = new Date(m.start_at); const me = new Date(m.end_at);
    pieces = pieces.flatMap((r) => {
      if (!overlap(r.start, r.end, ms, me)) return [r];
      const out = [];
      if (ms > r.start) out.push({ start: r.start, end: ms });
      if (me < r.end) out.push({ start: me, end: r.end });
      return out;
    });
  }
  return pieces;
}

// 判断 [wantStart, wantEnd] 与可营业区间是否相容；给锁定点做冲突解释
export function conflictsForVisit(avail, wantStart, wantEnd) {
  const conflicts = [];
  if (avail.closed_reason === 'date_closed') {
    conflicts.push({ type: 'closed_that_day', message: `当日は臨時休業です（${avail.note || '日別のお知らせ'}）` });
  } else if (avail.closed_reason === 'no_window') {
    conflicts.push({ type: 'no_service', message: 'この日・時間帯に営業している時窓がありません' });
  }
  for (const m of avail.maintenance) {
    const ms = new Date(m.start_at); const me = new Date(m.end_at);
    if (overlap(wantStart, wantEnd, ms, me)) {
      conflicts.push({
        type: 'maintenance', maintenance_id: m.id, title: m.title,
        start_at: m.start_at, end_at: m.end_at, all_day: m.all_day,
        message: `「${m.title}」(${fmtRange(m)}) と重なっています`,
      });
    }
  }
  const inside = avail.open_ranges.some((r) => wantStart >= r.start && wantEnd <= r.end);
  if (!conflicts.some((c) => c.type === 'maintenance' || c.type === 'date_closed') && !inside) {
    conflicts.push({
      type: 'outside_hours',
      message: '希望時間は営業時間外です（最新の営業時刻と一致しません）',
      open_ranges: avail.open_ranges,
    });
  }
  return conflicts;
}

function fmtRange(m) {
  const f = (d) => {
    const x = new Date(d);
    const jst = new Date(x.getTime() + 9 * 3600000).toISOString();
    return `${jst.slice(5, 10)} ${jst.slice(11, 16)}`;
  };
  return `${f(m.start_at)}〜${f(m.end_at)} JST`;
}
