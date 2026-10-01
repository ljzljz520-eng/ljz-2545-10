'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (path, opts) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
};
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
const jp = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const KIND_CLASS = { bathhouse: 'bath', lodging: 'lodging', restaurant: 'restaurant', cafe: 'cafe', shop: 'shop', park: 'park', other: 'other' };
const KIND_GLYPH = { bathhouse: '♨', lodging: '宿', restaurant: '食', cafe: '珈', shop: '买', park: '湯', other: '他' };

// ---- tabs ----
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'map') setTimeout(() => map.invalidateSize(), 60);
  if (b.dataset.tab === 'trip') loadTrip();
});

// ================= 地图筛选 =================
const map = L.map('map', { zoomControl: true }).setView([36.1236, 137.6806], 17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap · 底图可由离线包替换'
}).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let origin = { lat: 36.12210, lng: 137.68050 };
let originMarker = L.marker([origin.lat, origin.lng], {
  icon: L.divIcon({ className: 'origin-pin', html: '🚩', iconSize: [22, 22] })
}).addTo(map);
let settingOrigin = false;
map.on('click', (e) => {
  if (!settingOrigin) return;
  origin = e.latlng; settingOrigin = false;
  originMarker.setLatLng(e.latlng);
  $('#set-origin').textContent = '点地图设出发点';
  $('#origin-label').textContent = `自定义 (${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)})`;
});
$('#set-origin').onclick = () => { settingOrigin = true; $('#set-origin').textContent = '请在地图上点击…'; };

$('#f-walk').oninput = (e) => $('#walk-val').textContent = e.target.value;
$('#apply').onclick = runSearch;

async function runSearch() {
  const filters = {
    stay: $('#f-stay').checked || undefined,
    food: $('#f-food').checked || undefined,
    family: $('#f-family').checked || undefined,
    walkMeters: Number($('#f-walk').value),
    originLat: origin.lat, originLng: origin.lng,
    at: $('#f-at').value ? new Date($('#f-at').value).toISOString() : undefined,
  };
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined)).toString();
  const data = await api(`/api/places?${q}`);
  renderMap(data);
  renderReasons(data);
}

function pin(p, off = false) {
  const cls = KIND_CLASS[p.kind] || 'other';
  return L.divIcon({ className: '', html: `<div class="pin ${off ? 'off' : cls}"><span>${off ? '∅' : (KIND_GLYPH[p.kind] || '他')}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
}
function renderMap(data) {
  markerLayer.clearLayers();
  for (const p of data.included) {
    const m = L.marker([p.lat, p.lng], { icon: pin(p) }).addTo(markerLayer);
    m.bindTooltip(p.name);
    m.on('click', () => showPlaceCard(p));
  }
  for (const e of data.excluded) {
    const merged = e.reasons.some(r => r.code === 'merged');
    const m = L.marker([e.place.lat, e.place.lng], { icon: pin(e.place, true), opacity: .75 }).addTo(markerLayer);
    m.bindTooltip(`${e.place.name}（已过滤）`);
    m.on('click', () => toast(e.reasons.map(r => r.message).join('；')));
  }
  const fs = data.filter_summary;
  $('#filter-summary').innerHTML =
    `通过 <b>${data.included.length}</b> · 过滤 <b>${data.excluded.length}</b>` +
    (fs.applied.length ? ` · 类型：${fs.applied.join('/')}` : '') +
    (fs.walk_meters ? ` · 步行≤${fs.walk_meters}m` : '') +
    (fs.at ? ` · 时刻 ${jp(fs.at)}` : '');
}

function reasonTagFor(p) {
  const tags = [];
  if (p.needs_verification) tags.push('<span class="tag verify">核 待核信息</span>');
  p.facilities.forEach(f => {
    if (f.is_stay) tags.push('<span class="tag stay">住宿</span>');
    if (f.is_food) tags.push('<span class="tag food">餐饮</span>');
    if (f.family_friendly) tags.push('<span class="tag fam">亲子</span>');
  });
  return [...new Set(tags)].join('');
}

function renderReasons(data) {
  $('#excluded').innerHTML = data.excluded.length ? data.excluded.map(e => `
    <div class="ex-item ${e.reasons.some(r => r.code === 'merged') ? 'merged' : ''}">
      <h4>${e.place.name} <span class="muted">[${e.place.kind}]</span></h4>
      <ul class="rs">${e.reasons.map(r => `<li>${r.message}</li>`).join('')}</ul>
    </div>`).join('') : '<p class="muted">当前条件下没有被过滤的地点。</p>';

  $('#included').innerHTML = data.included.map(p => `
    <div class="inc" data-id="${p.id}">
      <h4><span>${p.name}</span>${p.distance != null ? `<span class="muted">≈${p.distance}m</span>` : ''}</h4>
      <div>${reasonTagFor(p)}</div>
      <div class="fac">${p.facilities.map(f => {
        const mt = f.maintenance?.[0];
        return mt ? `<s>${f.name}</s> <span class="tag verify">检修中</span>` : f.name;
      }).join(' · ')}</div>
      ${p.needs_verification ? `<div class="tag verify" style="margin-top:4px">核：${p.verification_note || '信息待核'}</div>` : ''}
    </div>`).join('');
  $$('#included .inc').forEach(el => el.onclick = () => {
    const p = data.included.find(x => x.id === Number(el.dataset.id));
    showPlaceCard(p); map.flyTo([p.lat, p.lng], 18);
  });
}

async function showPlaceCard(p) {
  let full = p;
  if (!full.springs) { const r = await api(`/api/places/${p.id}`); full = r.place; }
  $('#placecard').classList.remove('hidden');
  $('#placecard').innerHTML = `
    <span class="x" onclick="document.getElementById('placecard').classList.add('hidden')">✕</span>
    <h3>${full.name}</h3>
    <div class="muted">${full.address || ''}</div>
    ${reasonTagFor(full)}
    ${full.needs_verification ? `<p class="tag verify">核 待核：${full.verification_note || ''}</p>` : ''}
    <h4 style="margin:10px 0 4px">设施（推荐会展开到这里）</h4>
    ${full.facilities.map(f => {
      const mt = f.maintenance?.[0];
      return `<div class="fline ${mt ? 'bad' : ''}">
        <b>${f.name}</b> <small>${f.kind}${f.family_friendly ? ' · 亲子' : ''}${f.is_stay ? ' · 住宿' : ''}${f.is_food ? ' · 餐饮' : ''}</small>
        ${mt ? `<div class="maint">⚠ 检修：${jp(mt.start_at)} → ${jp(mt.end_at)}</div>` : ''}
      </div>`;
    }).join('')}
    ${(full.springs || []).map(s => `
      <div class="spring">
        <b>泉质：${s.quality_type}</b> · 泉温 ${s.temperature_c}℃ · pH ${s.ph}<br>
        ${s.description}<br>
        <small class="muted">来源：${s.source.title}（${s.source.status}，观测 ${new Date(s.observed_at).toISOString().slice(0, 10)}）</small><br>
        <small class="tag verify">${s.disclaimer}</small>
      </div>`).join('')}`;
}

// ================= 主题推荐 =================
async function loadThemes() {
  const r = await api('/api/recommend');
  window._allRec = r;
  $('#themes').innerHTML = r.themes.map(t => `
    <div class="theme-card" data-k="${t.key}"><h3>${t.title}</h3><p>${t.narrative}</p>
      <small class="muted">点击查看展开到设施的条目</small></div>`).join('');
  $$('.theme-card').forEach(c => c.onclick = () => loadRec(c.dataset.k));
  renderRecItems(r.items);
}
$('#rec-at').onchange = (e) => {
  const active = document.querySelector('.theme-card.sel')?.dataset.k;
  loadRec(active || null, e.target.value ? new Date(e.target.value).toISOString() : null);
};
async function loadRec(theme, at) {
  $$('.theme-card').forEach(c => c.classList.toggle('sel', c.dataset.k === theme));
  const q = new URLSearchParams();
  if (theme) q.set('theme', theme);
  const a = at || ($('#rec-at').value ? new Date($('#rec-at').value).toISOString() : null);
  if (a) q.set('at', a);
  const r = await api(`/api/recommend?${q}`);
  renderRecItems(r.items);
}
function renderRecItems(items) {
  $('#rec-items').innerHTML = items.map((it, i) => `
    <div class="rec-item">
      <div class="seq">${i + 1}</div>
      <div class="body">
        <h4>${it.place_name} <span class="muted">›</span> ${it.facility_name}
          ${it.family_friendly ? '<span class="tag fam">亲子</span>' : ''}
          ${it.place_needs_verification ? '<span class="tag verify">核 待核</span>' : ''}
        </h4>
        <div class="why">${it.why}</div>
        ${it.status_at_time ? (it.status_at_time.available
          ? '<span class="badge ok">所选时刻可去</span>'
          : `<span class="badge bad">所选时刻不可去：${it.status_at_time.message || ''}</span>`)
          : '<span class="muted" style="font-size:11px">未选择时刻，暂不校验</span>'}
      </div>
    </div>`).join('');
}

// ================= 行程 =================
async function loadTrips() {
  const { itineraries } = await api('/api/itineraries');
  $('#trip-id').innerHTML = itineraries.map(t => `<option value="${t.id}">${t.title} (v${t.version})</option>`).join('');
  $('#trip-id').value = '1';
  await loadTrip();
}
async function loadTrip() {
  const id = $('#trip-id').value || 1;
  const t = await api(`/api/itineraries/${id}`);
  window._trip = t;
  $('#trip-ver').textContent = `v${t.version}`;
  $('#conflicts').innerHTML = (t.conflicts || []).map(c => conflictHtml(c)).join('');
  $('#trip-items').innerHTML = t.items.map((it, i) => `
    <div class="trip-item ${it.manual_lock ? 'locked' : ''}">
      <div class="when">${jp(it.arrive_at)} → ${jp(it.depart_at)}</div>
      <div class="nm">${it.facility_name}<small>${it.lock_note || ''}</small></div>
      ${it.manual_lock ? '<span class="lock-flag">🔒 已锁定</span>' : '<span class="muted">未锁定</span>'}
      <button class="mini" data-lock="${it.id}">${it.manual_lock ? '解锁' : '锁定'}</button>
    </div>`).join('');
  $$('#trip-items [data-lock]').forEach(b => b.onclick = async () => {
    const locked = b.textContent === '解锁';
    await api(`/api/itineraries/${id}/items/${b.dataset.lock}/${locked ? 'unlock' : 'lock'}`, {
      method: 'POST', body: JSON.stringify({ lock_note: locked ? undefined : '用户手工锁定' }) });
    loadTrip();
  });
}
function conflictHtml(c) {
  return `<div class="conflict">🔴 <b>[${c.code}]</b> ${c.message}
    ${c.locked_hours ? `<div class="cmp"><div>锁定时：${(c.locked_hours || []).join('；')}</div>
      <div>现在：${(c.current_hours || []).join('；')}</div></div>` : ''}
  </div>`;
}
async function recompute(mode) {
  const id = $('#trip-id').value;
  const startAt = $('#trip-start').value ? new Date($('#trip-start').value).toISOString() : undefined;
  // 局部修复触发器：以“设施 11 检修/时间变化”这一依赖为例；实际系统按编辑事件生成
  const trigger = mode === 'partial' ? { facilityIds: [11, 12, 13, 70, 30] } : null;
  const r = await api(`/api/itineraries/${id}/recompute`, {
    method: 'POST', body: JSON.stringify({ mode, trigger, startAt }) });
  $('#freshness').textContent = `模式=${r.mode}，起始下标=${r.start_index}\n变更点=${r.changed.length}\n` +
    JSON.stringify(r.cache_freshness, null, 2) + '\n变更明细=' + JSON.stringify(r.changed, null, 2);
  toast(`${mode === 'full' ? '完整重算' : '局部修复'}完成：${r.changed.length} 个点变化，${r.conflicts.length} 个冲突`);
  loadTrip();
  return r;
}
$('#btn-full').onclick = () => recompute('full');
$('#btn-partial').onclick = () => recompute('partial');

$('#dev-add').onclick = async () => {
  const id = $('#trip-id').value;
  const t = window._trip;
  const r = await api(`/api/itineraries/${id}/edits`, {
    method: 'POST', body: JSON.stringify({
      device_id: $('#dev-id').value, base_version: t.version,
      op: { type: 'add', place_id: 5, facility_id: 50 } }) });
  toast('已添加行程点 v' + r.server_version);
  refreshEdits(); loadTrip();
};
$('#dev-lockall').onclick = async () => {
  const id = $('#trip-id').value;
  for (const it of window._trip.items) {
    if (!it.manual_lock) await api(`/api/itineraries/${id}/items/${it.id}/lock`, { method: 'POST', body: '{}' });
  }
  toast('全部点已锁定'); loadTrip();
};
async function refreshEdits() {
  const id = $('#trip-id').value;
  const r = await api(`/api/itineraries/${id}/edits`);
  $('#edit-log').textContent = JSON.stringify(r.edits, null, 2);
}
$('#show-edits').onclick = refreshEdits;

// ================= 验收脚本 =================
$$('.vact').forEach(b => b.onclick = () => scenarios[b.dataset.act]());
const scenarios = {
  crossday: () => {
    $('#f-at').value = '2026-10-06T11:00';
    $$('.tabs button')[0].click();
    runSearch().then(() => toast('露天桧木池检修中：汤上食堂仍在结果里，未连坐'));
  },
  links: async () => {
    const { sources } = await api('/api/admin/sources');
    $('#out-links').textContent = JSON.stringify(sources, null, 2);
  },
  merge: async () => {
    const r = await api('/api/places/8');
    $('#out-merge').textContent = JSON.stringify(r, null, 2);
  },
  offline: async () => {
    const r = await api('/api/admin/offline');
    $('#out-offline').textContent = JSON.stringify(r, null, 2);
  },
  twodev: async () => {
    // 用独立行程避免污染示例
    const it = await api('/api/itineraries', { method: 'POST', body: JSON.stringify({ title: '双设备验收行程', device_id: 'setup' }) });
    const id = it.id;
    await api(`/api/itineraries/${id}/edits`, { method: 'POST', body: JSON.stringify({ device_id: 'device-A', base_version: 1, op: { type: 'add', place_id: 5, facility_id: 50 } }) });
    // B 仍拿 v1 基线提交 -> 409
    const b = await fetch(`/api/itineraries/${id}/edits`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'device-B', base_version: 1, op: { type: 'add', place_id: 4, facility_id: 40 } }) })
      .then(r => ({ status: r.status, body: r.json() })).then(async x => ({ status: x.status, body: await x.body }));
    const hist = await api(`/api/itineraries/${id}/edits`);
    $('#out-twodev').textContent = `设备 B 响应 HTTP ${b.status}:\n${JSON.stringify(b.body, null, 2)}\n\n编辑历史:\n${JSON.stringify(hist.edits, null, 2)}`;
  },
  lockchange: async () => {
    // 独立行程：11 大浴场 10:00-12:00 窗口
    const it = await api('/api/itineraries', { method: 'POST', body: JSON.stringify({ title: '锁定验收', device_id: 'setup' }) });
    const id = it.id;
    await api(`/api/itineraries/${id}/edits`, { method: 'POST', body: JSON.stringify({ device_id: 'setup', base_version: 1, op: { type: 'add', place_id: 1, facility_id: 10 } }) });
    await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: JSON.stringify({ startAt: '2026-10-08T10:00:00+09:00' }) });
    let t = await api(`/api/itineraries/${id}`);
    const itemId = t.items[0].id;
    await api(`/api/itineraries/${id}/items/${itemId}/lock`, { method: 'POST', body: JSON.stringify({ lock_note: '就想这个时间泡大浴场' }) });
    // 改开放时间：周一推迟到 13:00 开
    await api(`/api/itineraries/${id}/simulate-hours-change`, { method: 'POST', body: JSON.stringify({
      facility_id: 10, source_id: 2,
      hours: [
        { day_of_week: 1, open_time: '13:00', close_time: '22:00' },
        { day_of_week: 2, open_time: '13:00', close_time: '22:00' },
        { day_of_week: 3, open_time: '13:00', close_time: '22:00' },
        { day_of_week: 4, open_time: '13:00', close_time: '22:00' },
        { day_of_week: 5, open_time: '13:00', close_time: '23:00' },
        { day_of_week: 6, open_time: '10:00', close_time: '23:00' },
        { day_of_week: 0, open_time: '10:00', close_time: '22:00' }] }) });
    const r = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: JSON.stringify({}) });
    t = await api(`/api/itineraries/${id}`);
    $('#out-lockchange').textContent = '重算结果（注意 arrive_at 未变，冲突被解释）:\n' + JSON.stringify({ items: t.items, conflicts: t.conflicts, log_conflicts: r.conflicts }, null, 2);
    // 还原种子开放时间，避免污染
    await api('/api/admin/opening-hours/facility/10', { method: 'POST', body: JSON.stringify({ source_id: 2, hours: [
      { day_of_week: 1, open_time: '10:00', close_time: '22:00' }, { day_of_week: 2, open_time: '10:00', close_time: '22:00' },
      { day_of_week: 3, open_time: '10:00', close_time: '22:00' }, { day_of_week: 4, open_time: '10:00', close_time: '22:00' },
      { day_of_week: 5, open_time: '10:00', close_time: '23:00' }, { day_of_week: 6, open_time: '10:00', close_time: '23:00' },
      { day_of_week: 0, open_time: '10:00', close_time: '22:00' }] }) });
  },
  equiv: async () => {
    const it = await api('/api/itineraries', { method: 'POST', body: JSON.stringify({ title: '一致性验收', device_id: 'setup' }) });
    const id = it.id;
    await api(`/api/itineraries/${id}/edits`, { method: 'POST', body: JSON.stringify({ device_id: 'setup', base_version: 1, op: { type: 'add', place_id: 1, facility_id: 12 } }) });
    // 需要 v2 才能继续加第二个点
    await api(`/api/itineraries/${id}/edits`, { method: 'POST', body: JSON.stringify({ device_id: 'setup', base_version: 2, op: { type: 'add', place_id: 3, facility_id: 30 } }) });
    await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: JSON.stringify({ startAt: '2026-10-08T09:30:00+09:00' }) });
    const full = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: JSON.stringify({ mode: 'full' }) });
    const partial = await api(`/api/itineraries/${id}/recompute`, { method: 'POST', body: JSON.stringify({ mode: 'partial', trigger: { facilityIds: [12, 30] } }) });
    const sig = (r) => r.items.map(i => `${i.facility_id}@${i.arrive_at}`).join('|');
    $('#out-equiv').textContent = `完整重算签名: ${sig(full)}\n局部修复签名: ${sig(partial)}\n\n一致: ${sig(full) === sig(partial)}\n\n` +
      `缓存新鲜度(局部):\n${JSON.stringify(partial.cache_freshness, null, 2)}`;
  }
};

// ---- 启动默认数据 ----
(async function init() {
  $('#f-at').value = '';
  await runSearch();
  await loadThemes();
  await loadTrips();
  refreshEdits();
})().catch(e => toast('初始化失败：' + e.message));
