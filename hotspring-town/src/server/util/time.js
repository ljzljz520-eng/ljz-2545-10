// 时间工具：演示数据位于虚构小镇「柚木沢」，采用固定的小镇时区 UTC+9。
// 生产部署时可用 TOWN_TZ 环境变量改为 Asia/Tokyo 等 IANA 名称。
export const TOWN_TZ = process.env.TOWN_TZ || 'UTC+9';

// 可注入时钟：测试用 SERVER_NOW / setNow 控制“当前时间”，保证跨日验收可复现
let _now = process.env.SERVER_NOW ? new Date(process.env.SERVER_NOW) : null;
export function setNow(d) { _now = d instanceof Date ? d : new Date(d); }
export function resetNow() { _now = null; }
export function now() { return _now ? new Date(_now) : new Date(); }

const TZ_OFFSET_MIN = (() => {
  const m = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(TOWN_TZ);
  if (!m) return 9 * 60;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
})();

export function tzOffsetMin() { return TZ_OFFSET_MIN; }

function parts(date) {
  const msUtc = date.getTime() + TZ_OFFSET_MIN * 60000;
  const d = new Date(msUtc);
  return d;
}

// 小镇本地日历日 'YYYY-MM-DD'
export function localDate(d = now()) {
  return parts(d).toISOString().slice(0, 10);
}
export function dateFromStr(s) { return new Date(`${s}T00:00:00`); }

export function dowOf(dateStr) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); // 0=Sun
}

// 小镇本地某日某分钟 -> 绝对时间
export function atMinute(dateStr, minute) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minute) - TZ_OFFSET_MIN * 60000);
}

export function minuteOfDay(d = now()) {
  const p = parts(d);
  return p.getUTCHours() * 60 + p.getUTCMinutes();
}

// 跨夜时窗归一化：close_min 可能 >1440。
// 返回该日“开始营业”的绝对时间与“关门”的绝对时间（关门可能落在次日）。
export function windowToRange(dateStr, openMin, closeMin) {
  const start = atMinute(dateStr, openMin);
  let endDate = dateStr;
  let endMin = closeMin;
  if (closeMin >= 1440) {
    const next = new Date(dateFromStr(dateStr).getTime() + 86400000);
    endDate = next.toISOString().slice(0, 10);
    endMin = closeMin - 1440;
  }
  const end = atMinute(endDate, endMin);
  return { start, end };
}

export function fmtMin(m) {
  const day = Math.floor(m / 1440);
  const mm = m - day * 1440;
  const h = Math.floor(mm / 60).toString().padStart(2, '0');
  const mi = (mm % 60).toString().padStart(2, '0');
  return day > 0 ? `次日${h}:${mi}` : `${h}:${mi}`;
}

export function fmtDate(d = now()) { return localDate(d); }

export function addDays(dateStr, n) {
  return new Date(dateFromStr(dateStr).getTime() + n * 86400000)
    .toISOString().slice(0, 10);
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
