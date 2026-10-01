// 地图筛选 + 推荐展开
//
// 层级纪律：
//  * 场馆(places)是地图聚合点；设施(facilities)是用户真正前往的单元
//  * 某场馆的一个泡池检修：该设施标记 unavailable，场馆仍显示，餐饮/住宿照常
//  * 只有当场馆下“没有任何可用设施”时才隐藏场馆，并给出明确过滤原因
import { buildGraph, shortestPaths, withinWalking } from './walking.js';
import { availabilityOnDate } from './availability.js';
import { localDate } from '../util/time.js';

const KIND_TO_PLACE = {
  lodging: ['lodging'], dining: ['dining'], onsen: ['onsen'], shop: ['shop'],
};

// family 需求关键词（筛“亲子设施”时，要求设施带这些属性之一）
const FAMILY_ATTR_KEYS = ['crib', 'baby_seat', 'kids_menu', 'shallow_water',
  'play_room', 'diaper_table', 'family_bath', 'high_chair', 'tatami',
  'step_free', 'wheelchair', 'changing_tent', 'stroller_rental', 'night_light'];

// 组装世界模型（repo 层用）
export function buildWorld({ places, facilities, windows, dateWindows, maintenance, edges }) {
  return {
    places: places.filter((p) => p.status === 'active'),
    facilities, windows, dateWindows: dateWindows || [], maintenance,
    graph: buildGraph(edges),
  };
}

// filters: { kinds:['lodging'|'dining'|'onsen'...], familyOnly:bool,
//            maxWalkSec:int|null, originPlaceId:string, date:'YYYY-MM-DD',
//            includeMaintenanceToday:bool }
export function filterPlaces(world, filters = {}) {
  const date = filters.date || localDate();
  const kinds = filters.kinds || [];
  const sp = filters.originPlaceId
    ? shortestPaths(world.graph, filters.originPlaceId) : null;

  const matched = []; const hidden = [];
  for (const place of world.places) {
    const reasons = [];
    if (kinds.length && !kinds.includes(place.kind)) {
      reasons.push({ code: 'kind_mismatch', detail: `カテゴリ「${place.kind}」は選択中カテゴリ外` });
    }
    // 步行距离（按路网真实耗时，不是直线）
    let walk = null;
    if (sp) {
      const hit = sp.get(place.id);
      if (!hit) reasons.push({ code: 'unreachable', detail: '歩行網で到達できません' });
      else {
        walk = hit;
        if (filters.maxWalkSec != null && hit.sec > filters.maxWalkSec) {
          reasons.push({ code: 'too_far', detail: `徒歩 ${Math.round(hit.sec / 60)} 分は指定圏外` });
        }
      }
    }
    if (reasons.length) { hidden.push({ place_id: place.id, name: place.name, reasons }); continue; }

    // 展开到设施级
    const facilities = world.facilities
      .filter((f) => f.place_id === place.id)
      .map((f) => annotateFacility(world, f, date, { familyOnly: filters.familyOnly }));

    if (filters.familyOnly) {
      const keep = facilities.filter((f) => f.family_match);
      for (const f of facilities.filter((f) => !f.family_match)) {
        f._hidden_reason = { code: 'not_family', detail: '親子向け属性なし' };
      }
      if (!keep.length && !place.family_friendly) {
        hidden.push({ place_id: place.id, name: place.name,
          reasons: [{ code: 'no_family_facility', detail: '親子で使える設備が見つかりません' }] });
        continue;
      }
    }

    const available = facilities.filter((f) => !filters.familyOnly || f.family_match);
    const allUnavailable = available.length > 0 && available.every((f) => f.today_unavailable);
    // 部分检修按“场馆全部设施”判断：哪怕筛选只看亲子设施，
    // 同馆另一个泡池检修也要在场所卡片上提示（不影响餐饮/住宿继续展示）
    if (available.length === 0) {
      hidden.push({ place_id: place.id, name: place.name,
        reasons: [{ code: 'no_facility_match', detail: '条件に合う施設がありません' }] });
      continue;
    }

    matched.push({
      ...place,
      walk_sec: walk ? walk.sec : null,
      walk_path: walk ? walk.path : null,
      facilities,
      partial_maintenance: facilities.some((f) => f.today_unavailable)
        && facilities.some((f) => !f.today_unavailable),
      all_unavailable: allUnavailable,
      family_place: place.family_friendly,
    });
  }
  return {
    date,
    filters,
    origin: filters.originPlaceId || null,
    matched,
    hidden,
    filter_summary: explainFilters(filters),
  };
}

export function annotateFacility(world, f, date, { familyOnly = false } = {}) {
  const avail = availabilityOnDate(world, f.id, date);
  const attrs = f.family_attrs || [];
  const familyMatch = f.family_friendly || attrs.some((a) => FAMILY_ATTR_KEYS.includes(a));
  const maintActive = avail.maintenance.length > 0;
  return {
    id: f.id, name: f.name, kind: f.kind, note: f.note || null,
    family_friendly: f.family_friendly, family_attrs: attrs, family_match: familyMatch,
    today_open: avail.open,
    today_unavailable: !avail.open,
    open_ranges: avail.open_ranges.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
    partial_open: maintActive && avail.open,
    maintenance: avail.maintenance.map((m) => ({
      id: m.id, title: m.title, start_at: m.start_at, end_at: m.end_at, all_day: m.all_day,
    })),
    closed_reason: avail.closed_reason,
    _hidden_reason: familyOnly && !familyMatch
      ? { code: 'not_family', detail: '親子向け属性なし' } : null,
  };
}

function explainFilters(filters) {
  const out = [];
  const names = { lodging: '宿泊', dining: '飲食', onsen: '温泉入浴', shop: '買い物' };
  if (filters.kinds?.length) out.push(`カテゴリ：${filters.kinds.map((k) => names[k] || k).join('・')}`);
  if (filters.familyOnly) out.push('親子設備のある施設のみ表示');
  if (filters.maxWalkSec != null && filters.originPlaceId) {
    out.push(`起点から徒歩 ${Math.round(filters.maxWalkSec / 60)} 分以内（歩行網の最短経路で判定）`);
  }
  if (!out.length) out.push('フィルタなし（全館表示）');
  return out;
}

// 推荐：把一个“场馆级”推荐条目展开成“用户真正要去的设施”候选
// input: [{place_id, reason, weight}]
export function expandRecommendations(world, entries, date) {
  return entries.map((e) => {
    const place = world.places.find((p) => p.id === e.place_id);
    if (!place) return { ...e, resolved: false, reason_codes: ['place_not_found'], facility_options: [] };
    const facilities = world.facilities
      .filter((f) => f.place_id === e.place_id && (!e.facilityKind || f.kind === e.facilityKind))
      .map((f) => annotateFacility(world, f, date, {}));
    const open = facilities.filter((f) => f.today_open);
    return {
      recommendation_key: e.key || e.place_id,
      place: { id: place.id, name: place.name, kind: place.kind },
      title: e.title || place.name,
      reason: e.reason,
      reason_codes: e.reasonCodes || [],
      resolved: true,
      facility_options: facilities,
      // 必须展开：给出可直接加入行程的设施，而非整馆
      actionable_facility_ids: open.map((f) => f.id),
      note: facilities.some((f) => f.today_unavailable) && open.length
        ? '一部設備が点検中のため、利用できる設備のみを候補にしています' : null,
    };
  });
}
