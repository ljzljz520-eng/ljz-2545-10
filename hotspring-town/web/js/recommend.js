import { api, state, fmtJST, banner } from './api.js';

export async function renderRecommendations() {
  const date = document.getElementById('recDate').value || state.date;
  document.getElementById('recDate').value = date;
  const r = await api.get('/api/recommendations?date=' + date);
  const list = document.getElementById('themeList');
  list.innerHTML = r.json.themes.map((t) => `
    <div class="theme-block">
      <div class="theme-title">✨ ${t.title}</div>
      <div class="theme-reason">${t.reason}</div>
      <div class="rec-grid">
        ${t.entries.map((e) => recCard(e)).join('')}
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-addfac]').forEach((b) =>
    b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('add-facility-to-plan', {
      detail: { id: b.dataset.addfac, name: b.dataset.name } }))));
}
function recCard(e) {
  if (!e.resolved) return `<div class="rec-card"><h4>${e.title || '?'}</h4><div class="hint">解決できません</div></div>`;
  return `<div class="rec-card">
    <h4>${e.title}</h4>
    ${e.note ? `<div class="rec-note">⚠ ${e.note}</div>` : ''}
    ${e.facility_options.map((f) => `
      <div class="rec-fac">
        <span>${f.family_friendly ? '👶 ' : ''}${f.name}
          <span class="pill ${f.today_open ? 'open' : 'off'}">${f.today_open ? '利用可' : '点検/休業'}</span>
        </span>
        ${f.today_open ? `<button class="btn secondary" style="font-size:11px;padding:1px 8px"
           data-addfac="${f.id}" data-name="${f.name}">追加</button>` : ''}
      </div>`).join('')}
  </div>`;
}
export function mountRecommend() {
  document.getElementById('recDate').value = state.date;
  document.getElementById('recDate').onchange = renderRecommendations;
}
