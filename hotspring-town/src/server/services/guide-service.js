// 地图筛选 / 推荐 / 泉质（描述性，不做医疗功效推断）
import * as repo from '../repo/repo.js';
import { buildWorld, filterPlaces, expandRecommendations } from '../engine/filter.js';
import { availabilityOnDate } from '../engine/availability.js';
import { localDate } from '../util/time.js';

export async function searchPlaces(filters = {}) {
  const world = await repo.loadWorld();
  const full = buildWorld(world);
  const result = filterPlaces(full, filters);
  result.edges = world.edges; // 供前端绘制步行网络
  return result;
}

export async function facilityDetail(id, date) {
  date = date || localDate();
  const world = await repo.loadWorld();
  const full = buildWorld(world);
  const fac = full.facilities.find((f) => f.id === id);
  if (!fac) return null;
  const place = full.places.find((p) => p.id === fac.place_id);
  const avail = availabilityOnDate(full, id, date);
  const sq = await repo.getSpringQuality(id);
  let source = null;
  if (sq?.source_id) [source] = await repo.getSourcesByIds([sq.source_id]);
  return {
    facility: {
      id: fac.id, name: fac.name, kind: fac.kind, note: fac.note,
      family_attrs: fac.family_attrs, family_friendly: fac.family_friendly,
    },
    place: place ? { id: place.id, name: place.name, kind: place.kind } : null,
    date,
    availability: {
      open: avail.open,
      open_ranges: avail.open_ranges.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
      maintenance: avail.maintenance,
      closed_reason: avail.closed_reason,
    },
    spring_quality: sq ? presentSpring(sq, source) : null,
    medical_disclaimer: '泉質の記述は成分表・聞き取りによる【説明的情報】であり、症状への効能や治療効果を意味するものではありません。',
    to_verify: buildToVerify(fac, place, sq, source),
  };
}

// 泉质只输出受控描述词 + 原文 + 来源 + 核验状态；禁止功效词
const BANNED_CLAIM_WORDS = ['cure', 'heal', 'treat', 'medical_effect', 'relieve_pain', 'beauty_effect'];
export function presentSpring(sq, source) {
  const claims = (sq.claims || []).filter((c) => !BANNED_CLAIM_WORDS.includes(c));
  return {
    source_text: sq.source_text,
    temperature_c: sq.temperature_c ? Number(sq.temperature_c) : null,
    claims_descriptive: claims,
    verified: sq.verified,
    source: source ? { id: source.id, title: source.title, url: source.url, trust: source.trust,
      link_state: source.link_state, fetched_at: source.fetched_at } : null,
    notice: [
      !sq.verified ? '未核実の情報です。最新の成分表を現地でご確認ください。' : null,
      source?.link_state === 'broken' ? '情報元リンクが切れています。内容は要再確認として扱っています。' : null,
    ].filter(Boolean).join(' ') || null,
  };
}

function buildToVerify(fac, place, sq, source) {
  const list = [];
  if (sq && !sq.verified) list.push({ field: 'spring_quality', message: '泉質の成分情報が未核実です' });
  if (source?.link_state === 'broken') list.push({ field: 'source_link', message: `出典リンク切れ（${source.http_status}）: ${source.title}` });
  if (source?.trust === 'stale') list.push({ field: 'source_freshness', message: '出典が古い可能性があります' });
  if (!fac.note && fac.kind !== 'other') list.push({ field: 'facility_note', message: '施設メモが未登録です' });
  return list;
}

// 推荐（演示：主题规则在服务层定义，引擎只做“展开到设施”）
const THEMES = [
  { key: 'family_halfday', title: '親子・半日まったり', place_ids: ['p_unzen','p_park','p_dining'],
    reason: 'キッズスペース・浅い水遊び場・お子様ランチを徒歩圏で組み立て',
    reasonCodes: ['family_attrs','walk_connected'] },
  { key: 'bath_crawl', title: '湯めぐり・午後プラン', place_ids: ['p_footbath','p_momiji','p_kiri'],
    reason: '足湯から共同浴場、大露天へ。点検中の設備は候補から自動除外',
    reasonCodes: ['bath_focus','maintenance_aware'] },
  { key: 'foodie_walk', title: '食べ歩きモデル', place_ids: ['p_shop','p_cafe','p_dining','p_kiri'],
    reason: '買い物→カフェ→食事処。同一地内のお風呂点検で飲食が消えない',
    reasonCodes: ['dining_focus','facility_independent'] },
];

export async function recommendations({ date, theme } = {}) {
  date = date || localDate();
  const world = await repo.loadWorld();
  const full = buildWorld(world);
  const themes = theme ? THEMES.filter((t) => t.key === theme) : THEMES;
  return themes.map((t) => ({
    theme_key: t.key, title: t.title, reason: t.reason, reason_codes: t.reasonCodes,
    entries: expandRecommendations(full, t.place_ids.map((pid, i) => ({
      key: `${t.key}_${i}`, place_id: pid, reason: t.reason, reasonCodes: t.reasonCodes,
    })), date),
  }));
}
