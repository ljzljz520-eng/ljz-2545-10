import { api } from './api.js';

export async function mountAbout() {
  const r = await api.get('/api/design');
  const d = r.json;
  document.getElementById('aboutContent').innerHTML = `
  <h2>プロダクトの位置づけ</h2>
  <p>${d.intro}</p>
  <h2>データモデル（PostgreSQL）</h2>
  <table><tr><th>テーブル</th><th>役割</th></tr>
  ${d.tables.map((t) => `<tr><td><code>${t.name}</code></td><td>${t.role}</td></tr>`).join('')}
  </table>
  <h2>守っている設計原則</h2>
  ${d.principles.map((p) => `<h3>${p.title}</h3><p>${p.body}</p>${p.list ? `<ul>${p.list.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}`).join('')}
  <h2>API 一覧</h2>
  <table><tr><th>メソッド</th><th>パス</th><th>説明</th></tr>
  ${d.api.map((a) => `<tr><td>${a.m}</td><td><code>${a.path}</code></td><td>${a.desc}</td></tr>`).join('')}
  </table>
  <h2>ディレクトリ構成</h2>
  <pre>${d.layout}</pre>`;
}
