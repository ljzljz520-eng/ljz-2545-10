const pool = require('../db/pool');

// 原创主题定义。每条推荐都“展开到设施”，不只给场馆。
const THEMES = {
  morning_mist: {
    key: 'morning_mist',
    title: '朝靄の湯めぐり（晨雾逐汤）',
    narrative: '开汤后第一缕蒸汽最干净：从内汤暖身，再把身体交给清晨的足汤步道。',
    want: { family: false, food: true },
    build: (places) => {
      const pick = [];
      const bath = f => f.kind === 'pool' || f.kind === 'bath_area';
      const ym = places.find(p => Number(p.id) === 1);
      if (ym) {
        const f = ym.facilities.find(x => x.id === 12) || ym.facilities.find(bath);
        if (f) pick.push({ place: ym.id, facility: f.id, why: '09:00 开汤的内汤大池，人少且亲子可入' });
      }
      const park = places.find(p => Number(p.id) === 5);
      if (park) { const f=park.facilities.find(x=>x.kind==='pool'); if(f) pick.push({place:5,facility:f.id,why:'川端足汤清晨开放，沿溪步行醒神'}); }
      if (ym) { const f = ym.facilities.find(x => x.is_food); if (f) pick.push({ place: 1, facility: f.id, why: '汤上食堂 11:30 开场，泡完直接吃' }); }
      return pick;
    },
  },
  family_foam: {
    key: 'family_foam',
    title: '泡のち親子（泡泡亲子半日）',
    narrative: '先让孩子在温和的亲子戏水厅放电，再到家庭友好的食堂坐下，全程步行 10 分钟圈。',
    want: { family: true, food: true },
    build: (places) => {
      const pick = [];
      const p7 = places.find(p => Number(p.id) === 7);
      if (p7) {
        const play = p7.facilities.find(f => f.kind === 'play_room');
        const nurse = p7.facilities.find(f => f.kind === 'nursing_room');
        if (play) pick.push({ place: 7, facility: play.id, why: '恒温戏水厅，浅水区适合幼儿（开放时间待核，页面会标注）' });
        if (nurse) pick.push({ place: 7, facility: nurse.id, why: '同馆母婴室，哺乳换尿布不用出建筑' });
      }
      const p3 = places.find(p => Number(p.id) === 3);
      if (p3) { const f = p3.facilities.find(x => x.is_food); if (f) pick.push({ place: 3, facility: f.id, why: '家庭餐桌与儿童椅，从亲子馆步行约 6 分钟' }); }
      return pick;
    },
  },
  night_steam: {
    key: 'night_steam',
    title: '夜蒸し屋台街（夜蒸小吃线）',
    narrative: '温泉街真正的烟火气在夜里：泡到晚场，再去跨夜营业的屋台吃一碗热面。',
    want: { food: true },
    build: (places) => {
      const pick = [];
      const ym = places.find(p => Number(p.id) === 1);
      if (ym) { const f = ym.facilities.find(x => x.id === 10); if (f) pick.push({ place: 1, facility: f.id, why: '大浴场周五开放至 23:00' }); }
      const y9 = places.find(p => Number(p.id) === 9);
      if (y9) { const f = y9.facilities.find(x => x.is_food); if (f) pick.push({ place: 9, facility: f.id, why: '夜鸣屋台 22:00 开、跨夜至次日 01:00（季节性，时间待核）' }); }
      return pick;
    },
  },
};

async function recommend({ at, theme, tz = 'Asia/Tokyo' } = {}) {
  const { loadPlaces } = require('./catalog');
  const places = await loadPlaces(true);
  const moment = at ? new Date(at) : null;

  const decorate = (entry) => {
    const place = places.find(p => Number(p.id) === Number(entry.place));
    const facility = place?.facilities.find(f => Number(f.id) === Number(entry.facility));
    if (!place || !facility) return null;
    const { facilityStatusAt } = require('./catalog');
    let status = null;
    if (moment) {
      const st = facilityStatusAt(facility, moment, null, tz);
      status = st.available
        ? { available: true }
        : { available: false, code: st.reason.code, message: st.reason.message,
            opens_later: st.reason.opens_later || null,
            maintenance: st.reason.maintenance ? { title: st.reason.maintenance.title, start_at: st.reason.maintenance.start_at, end_at: st.reason.maintenance.end_at } : undefined };
    }
    return {
      place_id: place.id, place_name: place.name, lat: place.lat, lng: place.lng,
      facility_id: facility.id, facility_name: facility.name, facility_kind: facility.kind,
      family_friendly: facility.family_friendly,
      place_needs_verification: place.needs_verification,
      place_verification_note: place.verification_note,
      default_duration_s: facility.default_duration_s,
      why: entry.why,
      status_at_time: status,
    };
  };

  if (theme) {
    const t = THEMES[theme];
    if (!t) throw Object.assign(new Error('未知主题'), { status: 404 });
    const items = t.build(places).map(decorate).filter(Boolean);
    return { theme: { key: t.key, title: t.title, narrative: t.narrative }, items };
  }
  // 通用推荐：所有主题条目聚合，标注推荐来源主题
  const all = [];
  for (const t of Object.values(THEMES)) {
    for (const e of t.build(places)) {
      const d = decorate(e);
      if (d) all.push({ ...d, from_theme: t.key, from_theme_title: t.title, why: e.why });
    }
  }
  // 去重（同设施只保留一次）
  const seen = new Set(); const uniq = [];
  for (const item of all) { const k = item.facility_id; if (!seen.has(k)) { seen.add(k); uniq.push(item); } }
  return { themes: Object.values(THEMES).map(t => ({ key: t.key, title: t.title, narrative: t.narrative })), items: uniq };
}

module.exports = { recommend, THEMES };
