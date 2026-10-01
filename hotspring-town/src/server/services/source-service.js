// 来源核查：HTTP 探测链接，更新 link_state。example.jp 等假域名用状态模拟。
import * as repo from '../repo/repo.js';
import { now } from '../util/time.js';

// 演示环境无外网时的映射：seed 数据自带期望状态；真实环境发 HEAD/GET
const STUB_STATUS = {
  'https://guide.example.jp/official/kirimiya': 200,
  'https://guide.example.jp/official/unzen': 200,
  'https://guide.example.jp/momiji/old-onsen-data': 404,
};

export async function checkAllLinks({ useNetwork = false } = {}) {
  const sources = await repo.listSources();
  const results = [];
  for (const s of sources) {
    if (!s.url) { results.push({ id: s.id, skipped: true, reason: 'no_url' }); continue; }
    let status = null; let state = 'unknown';
    if (useNetwork) {
      try {
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual',
          signal: AbortSignal.timeout(8000) });
        status = res.status;
        if (res.status >= 200 && res.status < 300) state = 'ok';
        else if (res.status >= 300 && res.status < 400) state = 'redirect';
        else if (res.status === 404 || res.status === 410) state = 'broken';
        else state = 'blocked';
      } catch { status = 0; state = 'broken'; }
    } else {
      status = STUB_STATUS[s.url] ?? (s.link_state === 'ok' ? 200 : 404);
      state = status >= 200 && status < 300 ? 'ok' : status === 404 || status === 410 ? 'broken' : 'redirect';
    }
    await repo.markLinkCheck(s.id, {
      httpStatus: status, linkState: state, okAt: state === 'ok' ? now() : null,
    });
    results.push({ id: s.id, url: s.url, http_status: status, link_state: state,
      became_broken: state === 'broken' && s.link_state !== 'broken' });
  }
  const broken = results.filter((r) => r.link_state === 'broken');
  return {
    checked_at: now().toISOString(), results,
    broken_count: broken.length,
    implications: broken.map((b) => ({
      source_id: b.id,
      message: '出典リンクが失効。関連する泉質・時刻情報は「要確認」へ格下げして表示します。',
    })),
  };
}

export async function sourcesList() {
  const rows = await repo.listSources();
  return rows.map((r) => ({
    id: r.id, title: r.title, url: r.url, kind: r.kind,
    http_status: r.http_status, link_state: r.link_state, trust: r.trust,
    fetched_at: r.fetched_at, last_ok_at: r.last_ok_at,
    stale: r.link_state === 'broken' || r.trust === 'stale',
  }));
}
