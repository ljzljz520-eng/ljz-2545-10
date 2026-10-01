// マップ描画（緯度経度→SVG座標変換＋歩行網）
import { api, walkMin, state, banner } from './api.js';

const KIND_ICON = { onsen: '♨', lodging: '🏨', dining: '🍚', shop: '🛍', facility: '🚌' };
const KIND_COLOR = { onsen: '#2e8ba8', lodging: '#7d5ba6', dining: '#d18f2b', shop: '#5a9152', facility: '#8a8378' };

function project(lat, lng, b) {
  const x = ((lng - b.minLng) / (b.maxLng - b.minLng)) * 900 + 50;
  const y = (1 - (lat - b.minLat) / (b.maxLat - b.minLat)) * 580 + 55;
  return [x, y];
}

export async function fetchFiltered(filters) {
  const p = new URLSearchParams();
  p.set('date', state.date);
  if (filters.kinds.length) p.set('kinds', filters.kinds.join(','));
  if (filters.familyOnly) p.set('family', '1');
  if (filters.walkEnable) { p.set('origin', filters.origin); p.set('maxWalkMin', filters.maxWalkMin); }
  const r = await api.get('/api/places?' + p.toString());
  return r.json;
}

export async function renderMap() {
  const kinds = [...document.querySelectorAll('#kindFilters input:checked')].map((x) => x.value);
  const familyOnly = document.getElementById('familyOnly').checked;
  const walkEnable = document.getElementById('walkEnable').checked;
  const maxWalkMin = Number(document.getElementById('walkRange').value);
  const origin = document.getElementById('originSelect').value;
  const filters = { kinds, familyOnly, walkEnable, maxWalkMin, origin };

  // 全 active 地点の geometry（種別を全部指定 = 実質フィルタなし）
  const geoR = await api.get(`/api/places?date=${state.date}&kinds=lodging,dining,onsen,shop,facility`);
  const geo = geoR.json;
  const data = await fetchFiltered(filters);
  window.__mapData = data; // パネル側で参照

  const all = geo.matched;
  state.placesGeo = new Map(all.map((p) => [p.id, p]));
  const lats = all.map((p) => p.lat), lngs = all.map((p) => p.lng);
  const b = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
  const xy = (id) => { const p = state.placesGeo.get(id); return p ? project(p.lat, p.lng, b) : null; };

  // edges
  const edgeLayer = document.getElementById('edgeLayer');
  edgeLayer.innerHTML = '';
  for (const e of data.edges || []) {
    const a = xy(e.from_place), c = xy(e.to_place);
    if (!a || !c) continue;
    const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
    edgeLayer.insertAdjacentHTML('beforeend',
      `<line class="edge ${e.path_kind}" x1="${a[0]}" y1="${a[1]}" x2="${c[0]}" y2="${c[1]}"/>
       <text class="edge-label" x="${mx}" y="${my - 3}">${Math.round(e.walk_sec / 60)}分</text>`);
  }

  const matchedIds = new Set(data.matched.map((p) => p.id));
  const layer = document.getElementById('placeLayer');
  layer.innerHTML = '';
  for (const p of all) {
    const [x, y] = project(p.lat, p.lng, b);
    const status = data.matched.find((m) => m.id === p.id);
    const visible = matchedIds.has(p.id);
    const partial = status?.partial_maintenance;
    const allOff = status?.all_unavailable;
    const color = KIND_COLOR[p.kind] || '#999';
    const icon = KIND_ICON[p.kind] || '•';
    layer.insertAdjacentHTML('beforeend', `
      <g class="marker ${visible ? '' : 'dim'} ${partial ? 'partial' : ''} ${allOff ? 'alloff' : ''} ${visible ? '' : 'opacity-gone'}" data-id="${p.id}" style="${visible ? '' : 'opacity:.18'}">
        <circle class="halo" cx="${x}" cy="${y}" r="30"/>
        <circle class="pin" cx="${x}" cy="${y}" r="17" fill="${color}"/>
        <text class="icon" x="${x}" y="${y + 6}">${icon}</text>
        <text x="${x}" y="${y - 24}">${p.name.length > 9 ? p.name.slice(0, 9) + '…' : p.name}</text>
      </g>`);
  }
  layer.querySelectorAll('.marker').forEach((g) => g.addEventListener('click', () => showPlace(g.dataset.id)));

  // summary / hidden
  document.getElementById('filterSummary').innerHTML =
    (data.filter_summary || []).map((x) => `・${x}`).join('<br>') +
    `<br>表示 ${data.matched.length} 件 / 非表示 ${data.hidden.length} 件`;
  const hl = document.getElementById('hiddenList');
  document.getElementById('hiddenCount').textContent = data.hidden.length;
  hl.innerHTML = data.hidden.map((h) =>
    `<li><div class="hname">${h.name}</div><div class="hreasons">${h.reasons.map((r) => '🚫 ' + r.detail).join('<br>')}</div></li>`).join('')
    || '<li class="hint">すべて表示されています</li>';

  document.getElementById('placePanel').innerHTML = `
    <div class="hint">マーカーを選ぶと、施設ごとの営業時間・点検・泉質を確認できます。
    点線の輪郭は「一部設備が点検中」、薄い表示は今の条件では非表示の地点です。</div>`;
}

async function showPlace(placeId) {
  document.querySelectorAll('.marker.selected').forEach((m) => m.classList.remove('selected'));
  document.querySelector(`.marker[data-id="${placeId}"]`)?.classList.add('selected');
  const date = state.date;
  const [d1, d2] = await Promise.all([
    api.get(`/api/places/${placeId}`),
    api.get(`/api/places?date=${date}&kinds=lodging,dining,onsen,shop,facility`),
  ]);
  const detail = d1.json;
  if (d1.status === 404 || !detail.place) {
    document.getElementById('placePanel').innerHTML = '<p>地点が見つかりません</p>';
    return;
  }
  const status = d2.json.matched.find((m) => m.id === detail.place.id);
  const facStatus = new Map((status?.facilities || []).map((f) => [f.id, f]));
  // リダイレクト説明
  let redirectHtml = '';
  if (detail.redirect_chain?.length) {
    const chain = detail.redirect_chain.map((c) => `${c.from} →`).join(' ');
    redirectHtml = `<div class="maint-note">🔀 統合された地点です（${chain} <b>${detail.place.id}</b>）。施設はそのまま使えます。</div>`;
  }
  const facs = detail.facilities.map(async (f) => {
    const s = facStatus.get(f.id);
    const open = s ? s.today_open : null;
    const ranges = (s?.open_ranges || []).map((r) =>
      `<span class="rangechip">${fmtHM(r.start)}–${fmtHM(r.end)}</span>`).join('');
    const maint = (s?.maintenance || []).map((m) =>
      `<div class="maint-note">🛠 ${m.title}<br>${fmtHM(m.start_at)}〜${fmtHM(m.end_at)}${m.all_day ? '（終日）' : ''}</div>`).join('');
    const badges = [
      f.family_friendly ? '<span class="badge family">👶 親子OK</span>' : '',
      (f.family_attrs || []).length ? `<span class="badge family">${f.family_attrs.join(', ')}</span>` : '',
      open === false ? '<span class="badge closed">本日利用不可</span>' : (s?.partial_open ? '<span class="badge partial">一部時間のみ利用可</span>' : ''),
    ].join('');
    // 泉質
    let spring = '';
    const fd = await api.get(`/api/facilities/${f.id}?date=${date}`);
    if (fd.json.spring_quality) {
      const q = fd.json.spring_quality;
      spring = `<div class="spring">💧 <b>泉質（説明）</b>：${q.source_text}
        <div class="src">出典：${q.source ? q.source.title : '不明'}${q.source ? `（${q.source.trust}${q.source.link_state === 'broken' ? '・リンク切れ' : ''}）` : ''}
        ${q.notice ? `<br>⚠ ${q.notice}` : ''}</div>
        <div class="disclaimer">${fd.json.medical_disclaimer}</div>`;
    }
    const toVerify = (fd.json.to_verify || []).map((v) => `<li>${v.message}</li>`).join('');
    const addBtn = open
      ? `<button class="btn secondary addfac-btn" data-facid="${f.id}" data-facname="${f.name}">＋ 行程に追加</button>` : '';
    return `<li class="fac-item ${open === false ? 'off' : ''}">
      <div class="fname">${f.name}</div>
      <div>${badges}</div>
      <div class="fac-meta">${ranges ? '利用枠 ' + ranges : '当日の時窓なし'}</div>
      ${f.note ? `<div class="fac-meta">${f.note}</div>` : ''}
      ${maint}${spring}
      ${toVerify ? `<ul class="toverify">🔎 要確認${toVerify}</ul>` : ''}
      ${addBtn}
    </li>`;
  });
  const facHtml = (await Promise.all(facs)).join('');
  const p = detail.place;
  document.getElementById('placePanel').innerHTML = `
    <div class="place-head">
      <h3>${p.name}</h3>
      <span class="kindtag ${p.kind}">${p.kind}</span>
    </div>
    <div class="fac-meta">${p.address || ''} ${p.phone || ''}</div>
    ${p.description ? `<div class="fac-meta">${p.description}</div>` : ''}
    ${redirectHtml}
    <ul class="fac-list">${facHtml}</ul>`;
  document.getElementById('placePanel').querySelectorAll('.addfac-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('add-facility-to-plan', {
        detail: { id: btn.dataset.facid, name: btn.dataset.facname } }));
      banner(`${btn.dataset.facname} をプランに追加する準備をしました（プランタブで確定）`);
    }));
}
function fmtHM(iso) {
  if (!iso) return '';
  const j = new Date(new Date(iso).getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}
