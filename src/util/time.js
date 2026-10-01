// 时间窗工具：全部以带偏移的绝对时间(Date)处理，避免跨日/时区歧义。
// JS Date.getDay(): 0=周日 … 6=周六，与 schema day_of_week 一致。

const MINUTE = 60_000;

// 指定时区在给定绝对时刻的 UTC 偏移（毫秒，东为正）
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    dftParts(dtf, date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - date.getTime();
}
// 某一时刻是否开放（开放窗覆盖该瞬间）；检修优先。
function openAtMoment(openRows, maintRows, moment, tz = "Asia/Tokyo") {
  const hits = maintenanceHits(maintRows, moment, new Date(moment.getTime() + 1000));
  if (hits.length) return { open: false, code: "maintenance", maintenance: hits[0],
    message: `${hits[0].title}：${fmt(hits[0].start_at)} – ${fmt(hits[0].end_at)}` };
  const iv = openIntervals(openRows, moment, new Date(moment.getTime() + 1000), tz);
  if (iv.length) return { open: true };
  // 给出“当天是否还会开”的信息，便于页面解释
  const dayStart = new Date(moment.getTime());
  const later = openIntervals(openRows, moment, new Date(moment.getTime() + 12 * 3600_000), tz);
  return { open: false, code: "closed", opens_later: later[0] ? later[0].start.toISOString() : null };
}

function dftParts(dtf, date) { return dtf.formatToParts(date); }

// 把“tz 时区的日历日 00:00”转成绝对时间
function localMidnightUTCms(y, m, d, off) { return Date.UTC(y, m, d) - off; }

/**
 * 求 rows 定义的周循环开放窗与绝对区间 [from,to] 的交集（绝对时间）。
 * 正确处理跨日(crosses_midnight)：以“营业起始日”为锚，关门时间加 24h。
 */
function openIntervals(rows, from, to, tz = 'Asia/Tokyo') {
  const out = [];
  const off = tzOffsetMs(from, tz);
  // from/to 对应到 tz 本地日历日
  const ls = new Date(from.getTime() + off);
  const le = new Date(to.getTime() + off);
  const y0 = ls.getUTCFullYear(), m0 = ls.getUTCMonth(), d0 = ls.getUTCDate();
  const y1 = le.getUTCFullYear(), m1 = le.getUTCMonth(), d1 = le.getUTCDate();

  const cursor = new Date(Date.UTC(y0, m0, d0 - 1)); // 前扫一天覆盖跨日窗
  const endDay = Date.UTC(y1, m1, d1 + 1);
  while (cursor.getTime() <= endDay) {
    const dayUTCms = cursor.getTime();              // 该本地日 00:00 对应的 UTC 毫秒
    const dow = cursor.getUTCDay();
    const dateStr = cursor.toISOString().slice(0, 10);
    for (const r of rows) {
      if (r.day_of_week !== dow) continue;
      if (r.effective_from && dateStr < toISODate(r.effective_from)) continue;
      if (r.effective_to && dateStr > toISODate(r.effective_to)) continue;
      const [oh, om] = hm(r.open_time);
      const [ch, cm] = hm(r.close_time);
      const openAbs = dayUTCms - off + oh * 3600_000 + om * MINUTE;
      let closeAbs = dayUTCms - off + ch * 3600_000 + cm * MINUTE;
      if (r.crosses_midnight) closeAbs += 86400_000;
      const s = Math.max(openAbs, from.getTime());
      const e = Math.min(closeAbs, to.getTime());
      if (e > s) out.push({ start: new Date(s), end: new Date(e), raw: r });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.sort((a, b) => a.start - b.start);
}

function toISODate(d) { return new Date(d).toISOString().slice(0, 10); }
function hm(t) { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return [h, m]; }

// 维护区间与 [from,to] 相交部分
function maintenanceHits(maintRows, from, to) {
  const out = [];
  for (const m of maintRows) {
    const s = new Date(m.start_at).getTime(), e = new Date(m.end_at).getTime();
    const ms = Math.max(s, from.getTime()), me = Math.min(e, to.getTime());
    if (me > ms) out.push({ ...m, hitStart: new Date(ms), hitEnd: new Date(me) });
  }
  return out.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

// [start,end] 是否可完整落在单个开放窗内、且不被维护打断
function feasibility(openRows, maintRows, start, end, tz = 'Asia/Tokyo') {
  if (!(end > start)) return { code: 'bad_window', message: '结束时间必须晚于开始时间' };
  const hits = maintenanceHits(maintRows, start, end);
  if (hits.length) {
    const m = hits[0];
    return { code: 'maintenance', message: `${m.title}：${fmt(m.start_at)} – ${fmt(m.end_at)}`, maintenance: m };
  }
  const iv = openIntervals(openRows, start, end, tz);
  const cover = iv.find(i => i.start.getTime() <= start.getTime() && i.end.getTime() >= end.getTime());
  if (!cover) {
    return { code: 'closed', message: '该时间段不在开放时间内',
      windows: iv.map(i => ({ start: i.start.toISOString(), end: i.end.toISOString() })) };
  }
  return null;
}

/**
 * 在 earliest 起、deadline 止内，寻找可容纳 durationMs 的最早可行段：
 * 必须在单一开放窗内，且不与维护重叠。
 */
function earliestSlot(openRows, maintRows, earliest, deadline, durationMs, tz = 'Asia/Tokyo') {
  const horizon = new Date(deadline.getTime() + 86400_000);
  const iv = openIntervals(openRows, earliest, horizon, tz);
  const mts = maintenanceHits(maintRows, earliest, horizon);
  for (const w of iv) {
    let cursor = Math.max(w.start.getTime(), earliest.getTime());
    const wEnd = Math.min(w.end.getTime(), deadline.getTime() + 86400_000);
    for (const m of mts) {
      const ms = new Date(m.start_at).getTime(), me = new Date(m.end_at).getTime();
      if (me <= cursor) continue;
      if (ms >= wEnd) continue;
      if (ms - cursor > durationMs) break; // 维护开始前放得下（结束点须严格早于检修）
      cursor = Math.max(cursor, me);
    }
    if (wEnd - cursor >= durationMs && cursor + durationMs <= deadline.getTime() + 1000) {
      return { start: new Date(cursor), end: new Date(cursor + durationMs) };
    }
  }
  return null;
}

function fmt(d) { return new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); }

module.exports = { tzOffsetMs, openIntervals, maintenanceHits, feasibility, earliestSlot, openAtMoment, MINUTE };
