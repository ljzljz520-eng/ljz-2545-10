import { createHash } from 'node:crypto';
// 稳定 JSON 序列化（键排序），用于数据指纹/缓存键
export function stableJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableJson).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}
export function sha1(s) { return createHash('sha1').update(s).digest('hex'); }
export function fingerprint(obj) { return sha1(stableJson(obj)).slice(0, 16); }
