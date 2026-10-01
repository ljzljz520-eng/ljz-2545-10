// 离线包：内容快照 + 显式过期。过期后不静默使用，API 返回 expired 横幅信息。
import * as repo from '../repo/repo.js';
import { fingerprint } from '../util/hash.js';
import { now } from '../util/time.js';

export async function publish({ versionTag, expiresAt, payload }) {
  const contentHash = fingerprint({ versionTag, payload });
  const id = await repo.publishOfflinePackage({ versionTag, contentHash, payload, expiresAt });
  return { id, version_tag: versionTag, content_hash: contentHash, expires_at: expiresAt };
}

// 生成“当前世界”离线包（由 admin 脚本/路由调用）
export async function snapshotPackage({ versionTag, ttlDays, includeItinerary = false }) {
  const world = await repo.loadWorld();
  const sources = await repo.listSources();
  const payload = {
    generated_at: now().toISOString(),
    town_tz: process.env.TOWN_TZ || 'UTC+9',
    places: world.places,
    facilities: world.facilities,
    windows: world.windows,
    date_windows: world.dateWindows,
    maintenance: world.maintenance,
    edges: world.edges,
    sources: sources.map(({ id, title, url, trust, link_state }) => ({ id, title, url, trust, link_state })),
  };
  const exp = new Date(now().getTime() + ttlDays * 86400000);
  return publish({ versionTag, expiresAt: exp.toISOString(), payload });
}

export async function fetchPackage(id) {
  const row = id ? await repo.getOfflinePackage(id) : await repo.latestOfflinePackage();
  if (!row) return null;
  const t = now();
  const expired = new Date(row.expires_at) <= t;
  return {
    id: row.id, version_tag: row.version_tag, content_hash: row.content_hash,
    published_at: row.published_at, expires_at: row.expires_at,
    expired,
    usable: !expired,
    banner: expired
      ? { level: 'warning', title: 'オフラインパックが期限切れです',
          message: 'このデータは読み取り専用で表示しています。最新情報はオンラインで再取得してください。更新しない限り新規予約・編集には使えません。' }
      : null,
    payload: row.payload,
  };
}
