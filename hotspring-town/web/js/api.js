// API クライアント + 端末・日付の共有状態
export const state = {
  device: localStorage.getItem('ynsw_device') || 'dev-phone-a',
  date: null,
  planId: localStorage.getItem('ynsw_plan') || null,
  planVersion: 1,
  placesGeo: new Map(), // place_id -> {lat,lng,...}
};

export function fmtJST(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}
export function fmtJSTTime(iso) {
  if (!iso) return '';
  const jst = new Date(new Date(iso).getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}
export const walkMin = (sec) => (sec == null ? '—' : Math.round(sec / 60) + '分');

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
};

// ブラウザの現在時刻を JST(UTC+9) の暦日に変換
export function todayJST() {
  const t = new Date();
  const jst = new Date(t.getTime() + (9 * 60 + t.getTimezoneOffset()) * 60000);
  return jst.toISOString().slice(0, 10);
}

export function banner(message, level = 'warn') {
  const el = document.getElementById('offlineBanner');
  el.textContent = message;
  el.className = 'banner' + (level === 'danger' ? ' danger' : '');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add('hidden'), 6000);
}
