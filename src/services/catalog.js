const pool = require('../db/pool');
const { openAtMoment } = require('../util/time');

const R = 6371_000;
function haversine(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat/2)**2 + Math.cos(aLat*rad)*Math.cos(bLat*rad)*Math.sin(dLng/2)**2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// 取地点 + 可展开设施 + 开放时间 + 当前/未来维护 + 泉质来源
async function loadPlaces(withDetails = true) {
  const { rows: places } = await pool.query(`
    SELECT p.id,p.name,p.kind,p.lat,p.lng,p.address,p.needs_verification,p.verification_note,
           p.merged_into AS merged_into_id, p.active,p.created_at,p.updated_at,
           m.name AS merged_into_name
    FROM place p LEFT JOIN place m ON m.id = p.merged_into
    ORDER BY p.id`);
  if (!withDetails) return places;
  const { rows: facilities } = await pool.query(`
    SELECT f.*, pf.name AS parent_name FROM facility f
    LEFT JOIN facility pf ON pf.id=f.parent_id WHERE f.active ORDER BY f.id`);
  const { rows: hours } = await pool.query(`SELECT * FROM opening_hours ORDER BY facility_id`);
  const { rows: maint } = await pool.query(
    `SELECT * FROM maintenance WHERE end_at > now() ORDER BY start_at`);
  const { rows: springs } = await pool.query(`
    SELECT sq.*, sr.kind AS source_kind, sr.status AS source_status, sr.title AS source_title,
           sr.url AS source_url, sr.retrieved_at
    FROM spring_quality sq JOIN source_record sr ON sr.id=sq.source_id`);
  for (const p of places) p.merged_into = p.merged_into_id != null ? Number(p.merged_into_id) : null;
  const byPlace = new Map(places.map(p => [Number(p.id), { ...p, facilities: [], springs: [] }]));
  for (const f of facilities) {
    f.opening_hours = hours.filter(h => h.facility_id === f.id);
    f.maintenance = maint.filter(m => m.facility_id === f.id);
    const pl = byPlace.get(Number(f.place_id)); if (pl) pl.facilities.push(f);
  }
  for (const s of springs) { const pl = byPlace.get(Number(s.place_id)); if (pl) pl.springs.push(s); }
  return [...byPlace.values()];
}

// 设施在某绝对时刻是否可用（开放且未检修）。返回 {available, reason}
function facilityStatusAt(facility, moment, _end, tz) {
  const st = openAtMoment(facility.opening_hours, facility.maintenance, moment, tz);
  if (!st.open) return { available: false, reason: st, facility };
  return { available: true, facility };
}

/**
 * 地图筛选。filters:
 *   stay / food / family: 需要至少一个匹配设施
 *   walkMeters + origin{lat,lng}: 直线/路网距离阈值
 *   at: ISO 时间；给出时附加“当时是否可去”的判定
 * 返回 {included, excluded:[{place,reasons:[...]}], reasons}
 */
async function search(filters = {}, tz = 'Asia/Tokyo') {
  const places = await loadPlaces(true);
  const included = [], excluded = [];
  const at = filters.at ? new Date(filters.at) : null;
  const endAt = at ? new Date(at.getTime() + 60*60000) : null;

  for (const place of places) {
    const reasons = [];

    if (!place.active && place.merged_into) {
      reasons.push({ code: 'merged', message: `已与「${place.merged_into_name}」合并，请前往合并后地点`, mergedInto: place.merged_into });
    } else if (!place.active) {
      reasons.push({ code: 'inactive', message: '地点已停用' });
    }

    let matched = place.facilities;
    const matchReasons = [];
    if (filters.stay) {
      matched = matched.filter(f => f.is_stay);
      matchReasons.push('住宿');
    }
    if (filters.food) {
      matched = matched.filter(f => f.is_food);
      matchReasons.push('餐饮');
    }
    if (filters.family) {
      matched = matched.filter(f => f.family_friendly);
      matchReasons.push('亲子设施');
    }
    if (filters.stay || filters.food || filters.family) {
      if (matched.length === 0) {
        reasons.push({ code: 'no_facility_match',
          message: `缺少匹配的设施类型（${matchReasons.join('、')}）；其他业态不会因个别设施检修而消失，但此处确实没有该类设施` });
      }
    }

    let distance = null;
    if (filters.origin && Number.isFinite(filters.walkMeters)) {
      distance = haversine(filters.origin.lat, filters.origin.lng, place.lat, place.lng);
      if (distance > filters.walkMeters) {
        reasons.push({ code: 'too_far', message: `距出发点约 ${Math.round(distance)} m，超过步行阈值 ${filters.walkMeters} m`, distance });
      }
    }

    // 在指定时刻：只排除“所有相关设施都不可用”的情况；部分泡池检修时其余设施照常展示
    let timeStatus = null;
    if (at && place.active && !place.merged_into) {
      const checkSet = ((filters.stay || filters.food || filters.family) ? matched : place.facilities)
        .filter(f => f.active !== false);
      const statuses = checkSet.map(f => facilityStatusAt(f, at, endAt, tz));
      const ok = statuses.filter(s => s.available);
      if (checkSet.length && ok.length === 0) {
        const anyMaint = statuses.some(s => s.reason?.code === 'maintenance');
        const opensLater = statuses.map(s => s.reason?.opens_later).find(Boolean);
        reasons.push({ code: 'unavailable_at_time',
          message: anyMaint
            ? `选定时段相关设施均在检修或闭馆（${statuses[0].reason.message}）`
            : (opensLater ? `选定时段未开放，最近 ${new Date(opensLater).toLocaleTimeString('zh-CN',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'})} 开放` : '选定时段相关设施均不开放'),
          detail: statuses.map(s => ({ facility: s.facility.name, reason: s.reason?.code, opens_later: s.reason?.opens_later || null })) });
      }
      timeStatus = statuses;
    }

    if (reasons.length === 0) {
      included.push({ ...serializePlace(place), id: Number(place.id), distance,
        matched_facilities: matched.map(f => f.id),
        time_status: timeStatus ? timeStatus.map(s => ({ facility: s.facility.id, available: s.available, reason: s.available?null:s.reason.code })) : undefined,
      });
    } else {
      excluded.push({ place: { id: Number(place.id), name: place.name, kind: place.kind, lat: place.lat, lng: place.lng }, reasons });
    }
  }
  return {
    included,
    excluded,
    filter_summary: {
      applied: Object.entries({ stay: '住宿', food: '餐饮', family: '亲子设施' })
        .filter(([k]) => filters[k]).map(([,v]) => v),
      walk_meters: filters.walkMeters ?? null,
      at: filters.at ?? null,
    },
  };
}

function serializePlace(place) {
  return {
    id: Number(place.id), name: place.name, kind: place.kind,
    lat: place.lat, lng: place.lng, address: place.address,
    active: place.active, merged_into: place.merged_into ? Number(place.merged_into) : null,
    needs_verification: place.needs_verification,
    verification_note: place.verification_note,
    facilities: place.facilities.map(f => ({
      id: f.id, parent_id: f.parent_id, name: f.name, kind: f.kind,
      family_friendly: f.family_friendly, is_stay: f.is_stay, is_food: f.is_food,
      walk_min_from_entrance: f.walk_min_from_entrance,
      maintenance: f.maintenance.map(m => ({ id: m.id, title: m.title, start_at: m.start_at, end_at: m.end_at })),
    })),
    springs: place.springs.map(s => ({
      quality_type: s.quality_type, temperature_c: s.temperature_c, ph: s.ph,
      description: s.description, observed_at: s.observed_at,
      source: { kind: s.source_kind, status: s.source_status, title: s.source_title, url: s.source_url, retrieved_at: s.retrieved_at },
      disclaimer: '泉质为带来源的观测性描述，不构成医疗功效承诺或治疗建议',
    })),
  };
}

async function getPlace(id) {
  const places = await loadPlaces(true);
  const p = places.find(x => Number(x.id) === Number(id));
  if (!p) return null;
  if (!p.active && p.merged_into) {
    return { redirect: { merged_into: p.merged_into, name: p.merged_into_name }, place: serializePlace(p) };
  }
  return { place: serializePlace(p) };
}

module.exports = { search, getPlace, loadPlaces, haversine, serializePlace, facilityStatusAt };
