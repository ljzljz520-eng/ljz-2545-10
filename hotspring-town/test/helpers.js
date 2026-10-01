import { buildGraph } from '../src/server/engine/walking.js';

// 不依赖数据库的世界模型夹具
export function makeWorld() {
  const places = [
    { id: 'p0', name: '起点', kind: 'facility', lat: 0, lng: 0, status: 'active', family_friendly: true },
    { id: 'p1', name: '汤馆', kind: 'onsen', lat: 0, lng: 0, status: 'active', family_friendly: true },
    { id: 'p2', name: '餐厅', kind: 'dining', lat: 0, lng: 0, status: 'active', family_friendly: false },
  ];
  const facilities = [
    { id: 'f_bath', place_id: 'p1', name: '大浴池', kind: 'bath', family_friendly: false, family_attrs: [], data_updated_at: '2026-09-01T00:00:00Z' },
    { id: 'f_kids', place_id: 'p1', name: '亲子池', kind: 'bath', family_friendly: true, family_attrs: ['baby_seat'], data_updated_at: '2026-09-01T00:00:00Z' },
    { id: 'f_room', place_id: 'p1', name: '客房', kind: 'room', family_friendly: true, family_attrs: ['crib'], data_updated_at: '2026-09-01T00:00:00Z' },
    { id: 'f_food', place_id: 'p2', name: '餐厅大堂', kind: 'restaurant', family_friendly: false, family_attrs: [], data_updated_at: '2026-09-01T00:00:00Z' },
  ];
  // 2026-10-04 是周日(dow=0)
  const windows = [
    { id: 'w1', facility_id: 'f_bath', dow: 0, open_min: 900, close_min: 1380 },  // 15:00-23:00
    { id: 'w2', facility_id: 'f_kids', dow: 0, open_min: 600, close_min: 1080 },  // 10:00-18:00
    { id: 'w3', facility_id: 'f_food', dow: 0, open_min: 660, close_min: 1260 },  // 11:00-21:00
  ];
  const maintenance = [];
  const edges = [
    { id: 'e1', from_place: 'p0', to_place: 'p1', walk_sec: 300, path_kind: 'street' }, // 5分
    { id: 'e2', from_place: 'p1', to_place: 'p2', walk_sec: 600, path_kind: 'street' }, // 10分
  ];
  return {
    places, facilities, windows, dateWindows: [], maintenance, edges,
    graph: buildGraph(edges),
  };
}

export const SUN = '2026-10-04';
