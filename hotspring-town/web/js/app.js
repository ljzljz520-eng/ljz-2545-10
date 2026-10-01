import { state, todayJST } from './api.js';
import { renderMap } from './map.js';
import { mountPlan } from './plan.js';
import { renderRecommendations, mountRecommend } from './recommend.js';
import { mountAdmin } from './admin.js';
import { mountAbout } from './about.js';

state.date = todayJST();
state.device = document.getElementById('deviceSelect').value =
  localStorage.getItem('ynsw_device') || 'dev-phone-a';

document.getElementById('mapDate').value = state.date;

// タブ切替
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tabpanel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'map') renderMap();
  if (t.dataset.tab === 'recommend') renderRecommendations();
}));

// 端末
document.getElementById('deviceSelect').addEventListener('change', (e) => {
  state.device = e.target.value;
  localStorage.setItem('ynsw_device', state.device);
});

// 日付・フィルタ
['kindFilters', 'familyOnly', 'walkEnable', 'walkRange', 'originSelect'].forEach((id) =>
  document.getElementById(id).addEventListener('change', renderMap));
document.getElementById('mapDate').addEventListener('change', (e) => { state.date = e.target.value; renderMap(); });
document.getElementById('walkRange').addEventListener('input', (e) => {
  document.getElementById('walkLabel').textContent = e.target.value + '分';
});

// 起点セレクトを埋める
(async function fillOrigins() {
  const r = await fetch('/api/places?date=' + state.date + '&kinds=lodging,dining,onsen,shop,facility');
  const d = await r.json();
  const opts = d.matched.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  document.getElementById('originSelect').innerHTML = opts;
  document.getElementById('originSelect').value = 'p_station';
  renderMap();
})();

mountPlan();
mountRecommend();
mountAdmin();
mountAbout();
