import { api, state, fmtJST, banner } from './api.js';

// 管理操作で変わった基礎データを蓄積（部分修復のトリガに使う）
export const dirty = { windows: [], maintenance: [], facilities: [], edges: [], places: [] };

async function loadMaint() {
  const r = await api.get('/api/admin/maintenance?date=' + state.date);
  const box = document.getElementById('maintList');
  box.innerHTML = r.json.maintenance.map((m) =>
    `<div class="slot-item">🛠 <b>${m.title}</b><br><span class="fac-meta">${m.facility_id || m.place_id}｜${fmtJST(m.start_at)}〜${fmtJST(m.end_at)}｜${m.status}</span>${m.note ? `<br><span class="fac-meta">${m.note}</span>` : ''}</div>`
  ).join('') || '<p class="hint">この日の予定はありません</p>';
  // facility select
  const pl = await api.get('/api/places?date=' + state.date + '&kinds=lodging,dining,onsen,shop,facility');
  const opts = pl.json.matched.flatMap((p) => p.facilities.map((f) => `<option value="${f.id}">${p.name} / ${f.name}</option>`)).join('');
  document.getElementById('maintFacility').innerHTML = opts;
  document.getElementById('mergeKept').innerHTML = pl.json.matched.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  document.getElementById('mergeRemoved').innerHTML = pl.json.matched.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function addMaint() {
  const fac = document.getElementById('maintFacility').value;
  const start = document.getElementById('maintStart').value;
  const end = document.getElementById('maintEnd').value;
  const title = document.getElementById('maintTitle').value || '臨時点検';
  if (!start || !end) return banner('開始・終了を入れてください', 'danger');
  const r = await api.post('/api/admin/maintenance', {
    facility_id: fac, title,
    start_at: new Date(new Date(start).getTime() - 9 * 3600000).toISOString(),
    end_at: new Date(new Date(end).getTime() - 9 * 3600000).toISOString(),
  });
  if (!r.ok) return banner('登録失敗: ' + r.json.error, 'danger');
  if (!dirty.maintenance.includes(r.json.id)) dirty.maintenance.push(r.json.id);
  banner('点検を登録。プランの「部分修復」で反映できます');
  loadMaint();
}

async function checkLinks() {
  const r = await api.post('/api/sources/check', { useNetwork: false });
  const ul = document.getElementById('sourceList');
  ul.innerHTML = r.json.results.filter((x) => !x.skipped).map((x) =>
    `<li>${x.url}<span class="src-state ${x.link_state}">${x.http_status} ${x.link_state}</span>${x.became_broken ? '<br><span class="rec-note">⚠ 新たにリンク切れ。関連情報は要確認扱いになります。</span>' : ''}</li>`
  ).join('');
  const noUrl = r.json.results.filter((x) => x.skipped).length;
  ul.insertAdjacentHTML('beforeend', `<li class="hint">（URL なしの現地調査・電話メモ ${noUrl} 件は対象外）</li>`);
  banner(`リンク核查完了：${r.json.broken_count} 件が失効`);
}

async function mergePlaces() {
  const keptId = document.getElementById('mergeKept').value;
  const removedId = document.getElementById('mergeRemoved').value;
  const reason = document.getElementById('mergeReason').value;
  if (keptId === removedId) return banner('同じ地点は統合できません', 'danger');
  const r = await api.post('/api/admin/places/merge', { keptId, removedId, reason, deviceId: state.device });
  if (!r.ok) return banner('統合失敗: ' + r.json.error, 'danger');
  banner(`統合しました（設備 ${r.json.moved_facilities.length}、辺 ${r.json.moved_edges} を移行。旧IDはリダイレクト）`);
  dirty.places.push(removedId);
  loadMaint();
}

async function publishOffline(ttl) {
  const r = await api.post('/api/admin/offline/publish', { ttlDays: ttl });
  banner('パック発行: ' + r.json.id);
  getOffline();
}
async function getOffline() {
  const r = await api.get('/api/offline/latest');
  const el = document.getElementById('offlineInfo');
  if (r.status === 404) { el.textContent = 'パックがありません'; return; }
  const p = r.json;
  const head = { id: p.id, version: p.version_tag, expires_at: p.expires_at, expired: p.expired, banner: p.banner };
  el.textContent = JSON.stringify(head, null, 2) + `\n\npayload 規模: places=${p.payload.places?.length} facilities=${p.payload.facilities?.length} windows=${p.payload.windows?.length}`;
  if (p.expired) banner('⚠ 期限切れパック：読み取り専用で表示します（新規編集には使いません）', 'danger');
}

export function mountAdmin() {
  loadMaint();
  document.getElementById('maintAddBtn').onclick = addMaint;
  document.getElementById('linkCheckBtn').onclick = checkLinks;
  document.getElementById('mergeBtn').onclick = mergePlaces;
  document.getElementById('offlinePubBtn').onclick = () => publishOffline(30);
  document.getElementById('offlineExpBtn').onclick = () => publishOffline(-1);
  document.getElementById('offlineGetBtn').onclick = getOffline;
}
