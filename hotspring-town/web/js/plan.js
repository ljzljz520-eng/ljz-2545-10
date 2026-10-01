// マイプラン：行程編集・ロック・再計算/部分修復・時間帯組み合わせ
import { api, state, fmtJST, fmtJSTTime, walkMin, banner } from './api.js';

let facilities = [];
let currentPlan = null;

export async function initPlan() {
  const [pl, fac] = await Promise.all([api.get('/api/places?date=' + state.date + '&kinds=lodging,dining,onsen,shop,facility'), Promise.resolve(null)]);
  void fac;
  facilities = [];
  for (const p of pl.json.matched) for (const f of p.facilities) facilities.push({ ...f, place_id: p.id, place_name: p.name });
  fillSelects();
  document.getElementById('planDate').value = state.date;
  const list = await api.get('/api/itineraries');
  const sel = document.getElementById('planSelect');
  sel.innerHTML = list.json.itineraries.map((i) => `<option value="${i.id}" ${i.id === state.planId ? 'selected' : ''}>${i.title}（${i.visit_date} v${i.version}）</option>`).join('');
  if (!state.planId && list.json.itineraries[0]) state.planId = list.json.itineraries[0].id;
  if (state.planId) await loadPlan();
}
function fillSelects() {
  const opts = facilities.map((f) => `<option value="${f.id}">${f.name}（${f.place_name}）</option>`).join('');
  document.getElementById('addFacilitySelect').innerHTML = opts;
  const fp = document.getElementById('planOrigin');
  if (!fp.options.length) {
    const placeOpts = [...new Map(facilities.map((f) => [f.place_id, f.place_name])).entries()]
      .map(([id, name]) => `<option value="${id}" ${id === 'p_station' ? 'selected' : ''}>${name}</option>`).join('');
    fp.innerHTML = placeOpts;
  }
  document.querySelectorAll('select[data-facopts]').forEach((s) => { s.innerHTML = opts; });
}

async function loadPlan() {
  const r = await api.get('/api/itineraries/' + state.planId);
  if (r.status === 404) { currentPlan = null; return; }
  currentPlan = r.json;
  state.planVersion = currentPlan.version;
  renderPlan();
}

function renderPlan() {
  if (!currentPlan) {
    document.getElementById('planItems').innerHTML = '<li class="hint">プランを作成してください</li>';
    return;
  }
  document.getElementById('planMeta').innerHTML =
    `日付 <b>${currentPlan.visit_date}</b>｜バージョン <b>v${currentPlan.version}</b>｜${currentPlan.items.length} 件`;
  const ol = document.getElementById('planItems');
  ol.innerHTML = '';
  currentPlan.items.forEach((it, i) => {
    const fac = facilities.find((f) => f.id === it.facility_id);
    const name = it.facility_snapshot || fac?.name || it.facility_id;
    const placeName = fac?.place_name || '—';
    const conflict = it.conflict;
    const li = document.createElement('li');
    li.className = 'plan-item' + (it.locked ? ' locked' : '') + (conflict ? ' inconflict' : '');
    li.innerHTML = `
      <div class="idx">${i + 1}</div>
      <div>
        <div class="pi-name">${name} ${conflict ? '⚠' : ''}</div>
        <div class="pi-place">${placeName}</div>
        <div class="pi-time">${fmtJST(it.planned_start)} 〜 ${fmtJST(it.planned_end)}</div>
      </div>
      <div style="text-align:right">
        <button class="lockbtn ${it.locked ? 'on' : ''}" data-i="${i}">${it.locked ? '🔒 ロック中' : '🔓 ロック'}</button><br>
        <button class="delbtn" data-del="${i}" title="削除">✕</button>
      </div>
      ${it.locked ? `<div class="locktime">ロック時刻 <input type="datetime-local" step="900" value="${fmtJSTTime(it.planned_start)}" data-lockstart="${i}">
        <button class="btn secondary" data-setlock="${i}" style="font-size:11px;padding:2px 8px">時刻を反映</button></div>` : ''}
      ${conflict ? `<div class="conflict-box"><b>変更を検知（ロックは保持）</b><br>` +
        conflict.conflicts.map((c) => '⚠ ' + c.message).join('<br>') + `</div>` : ''}`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('.lockbtn').forEach((b) => b.addEventListener('click', () => toggleLock(Number(b.dataset.i))));
  ol.querySelectorAll('.delbtn').forEach((b) => b.addEventListener('click', () => removeItem(Number(b.dataset.del))));
  ol.querySelectorAll('[data-setlock]').forEach((b) => b.addEventListener('click', () => setLockTime(Number(b.dataset.setlock))));
}

async function saveItems(items, action) {
  const r = await api.put(`/api/itineraries/${state.planId}/items`, {
    deviceId: state.device, expectedVersion: state.planVersion, action, items,
  });
  if (!r.ok && r.json.error === 'version_conflict') {
    banner(`📵 別端末が先に保存しています（最新 v${r.json.currentVersion}）。内容を読み込み直します。変更は再適用してください。`, 'danger');
    state.planVersion = r.json.currentVersion;
    await loadPlan();
    return null;
  }
  state.planVersion = r.json.version;
  currentPlan.items = r.json.items;
  renderPlan();
  renderConsistency(r.json);
  return r.json;
}
function renderConsistency(plan) {
  const box = document.getElementById('consistencyBox');
  if (plan.full_equivalence) {
    box.className = 'consistency ' + (plan.full_equivalence.consistent ? 'ok' : 'bad');
    box.innerHTML = plan.full_equivalence.consistent
      ? `✅ 部分修復と全体再計算の結果が一致（再利用: ${plan.repair.reused_indexes.join(',') || 'なし'}／変化: ${plan.repair.affected_indexes.join(',') || 'なし'}）`
      : '❌ 不一致：' + JSON.stringify(plan.full_equivalence.diffs);
  }
}

async function toggleLock(i) {
  const items = currentPlan.items.map((it, idx) => {
    if (idx === i) return { ...it, locked: !it.locked };
    return { ...it };
  });
  await saveItems(items, 'lock');
}
async function setLockTime(i) {
  const input = document.querySelector(`[data-lockstart="${i}"]`);
  const local = input.value; // 入力は JST 想定
  if (!local) return;
  const startUtc = new Date(local).getTime() - 9 * 3600000;
  const start = new Date(startUtc).toISOString();
  const end = new Date(startUtc + 3600000).toISOString();
  const items = currentPlan.items.map((it, idx) => idx === i
    ? { ...it, locked: true, planned_start: start, planned_end: end } : { ...it });
  await saveItems(items, 'lock');
}
async function removeItem(i) {
  const items = currentPlan.items.filter((_, idx) => idx !== i);
  await saveItems(items, 'remove');
}
async function addFacility(facId) {
  if (!currentPlan) { banner('先にプランを作成してください', 'danger'); return; }
  const items = [...currentPlan.items.map((it) => ({ ...it })), { facility_id: facId }];
  await saveItems(items, 'add');
}

async function recompute() {
  const r = await api.post(`/api/itineraries/${state.planId}/recompute`, { deviceId: state.device });
  state.planVersion = r.json.version; currentPlan.items = r.json.items; renderPlan();
  banner('全体を再計算しました（ロック点はそのまま）');
}
async function repair() {
  // 代表的な変更として、時窗・点検の変更をサーバ側で検出させるため全施設を走らせるのではなく、
  // 利用者に原因を選ばせる簡易UI：ここでは全设施の windows 変更を仮告知し、指纹で実影響のみ判定
  const r = await api.post(`/api/itineraries/${state.planId}/repair`, {
    deviceId: state.device,
    changes: { windows: facilities.map((f) => f.id), maintenance: ['m_roten_overnight','m_roten_multiday','m_iwa_partial','m_footbath_zone2'] },
  });
  state.planVersion = r.json.version; currentPlan.items = r.json.items; renderPlan(); renderConsistency(r.json);
  banner(`部分修復：変化した点 ${r.json.repair.affected_indexes.length} 件（指纹で実影響のみ再計算）`);
}

async function createPlan() {
  const visitDate = document.getElementById('planDate').value;
  const startPlaceId = document.getElementById('planOrigin').value || 'p_station';
  const r = await api.post('/api/itineraries', { title: `${visitDate} プラン`, visitDate, startPlaceId, deviceId: state.device });
  state.planId = r.json.id; localStorage.setItem('ynsw_plan', state.planId); state.planVersion = 1;
  await initPlan();
}

async function renderSlots() {
  const box = document.getElementById('slotsPick');
  box.innerHTML = facilities.map((f) =>
    `<label><input type="checkbox" value="${f.id}"> ${f.name}</label>`).join('');
}
async function combineSlots() {
  const ids = [...document.querySelectorAll('#slotsPick input:checked')].map((x) => x.value);
  if (!ids.length) return banner('設備を選んでください', 'danger');
  const r = await api.get(`/api/slots?facilities=${ids.join(',')}&date=${state.date}&origin=${document.getElementById('planOrigin').value || 'p_station'}`);
  document.getElementById('slotsResult').innerHTML = r.json.slots.map((s) => {
    const fac = facilities.find((f) => f.id === s.facility_id);
    return `<div class="slot-item"><b>${fac?.name || s.facility_id}</b>
      ${s.open ? s.ranges.map((x) => `<span class="rangechip">${fmtJST(x.start)}–${fmtJST(x.end)}</span>`).join('') : '<span class="badge closed">利用不可</span>'}
      ${s.maintenance.map((m) => `<div class="fac-meta">🛠 ${m.title}${m.all_day ? '（終日）' : ''}</div>`).join('')}
      </div>`;
  }).join('') + '<div class="hint">最早のつながり（下から「行程に追加」でプラン化）</div>';
}

export function mountPlan() {
  document.getElementById('newPlanBtn').onclick = createPlan;
  document.getElementById('planSelect').onchange = (e) => { state.planId = e.target.value; localStorage.setItem('ynsw_plan', state.planId); loadPlan(); };
  document.getElementById('addItemBtn').onclick = () => addFacility(document.getElementById('addFacilitySelect').value);
  document.getElementById('recomputeBtn').onclick = recompute;
  document.getElementById('repairBtn').onclick = repair;
  document.getElementById('slotsBtn').onclick = combineSlots;
  document.getElementById('planDate').onchange = (e) => { state.date = e.target.value; };
  window.addEventListener('add-facility-to-plan', (e) => addFacility(e.detail.id));
  initPlan(); renderSlots();
}
