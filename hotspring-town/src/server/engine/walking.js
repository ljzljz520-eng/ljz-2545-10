// 步行路网：无向图上的多源 Dijkstra。
// 边的 walk_sec 为实测耗时（含坡道/台阶差异），比直线距离更贴近“路段耗时一致”。

export function buildGraph(edges) {
  const g = new Map();
  for (const e of edges) {
    if (!g.has(e.from_place)) g.set(e.from_place, []);
    if (!g.has(e.to_place)) g.set(e.to_place, []);
    g.get(e.from_place).push({ to: e.to_place, sec: e.walk_sec, edgeId: e.id, kind: e.path_kind });
    g.get(e.to_place).push({ to: e.from_place, sec: e.walk_sec, edgeId: e.id, kind: e.path_kind });
  }
  return g;
}

// 从单个起点计算到所有可达地点的最短步行秒数（-1 = 不可达）
export function dijkstra(graph, source) {
  const dist = new Map();
  dist.set(source, 0);
  const visited = new Set();
  // 简单二叉堆规模足够（演示小镇 <100 节点）
  const pq = [{ id: source, d: 0 }];
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { id, d } = pq.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const n of graph.get(id) || []) {
      if (visited.has(n.to)) continue;
      const nd = d + n.sec;
      if (dist.get(n.to) === undefined || nd < dist.get(n.to)) {
        dist.set(n.to, nd);
        pq.push({ id: n.to, d: nd });
      }
    }
  }
  return dist;
}

// 返回 { placeId -> {sec, path:[edgeId...]} }，同时记录路径
export function shortestPaths(graph, source) {
  const dist = new Map([[source, 0]]);
  const prev = new Map(); // to -> {from, edgeId}
  const visited = new Set();
  const pq = [{ id: source, d: 0 }];
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { id, d } = pq.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const n of graph.get(id) || []) {
      const nd = d + n.sec;
      if (dist.get(n.to) === undefined || nd < dist.get(n.to)) {
        dist.set(n.to, nd);
        prev.set(n.to, { from: id, edgeId: n.edgeId });
        pq.push({ id: n.to, d: nd });
      }
    }
  }
  const result = new Map();
  for (const [id, sec] of dist) {
    const path = [];
    let cur = id;
    while (cur !== source) {
      const p = prev.get(cur);
      if (!p) break;
      path.unshift(p.edgeId);
      cur = p.from;
    }
    result.set(id, { sec, path: id === source ? [] : path });
  }
  return result;
}

// 两点间最短（用于行程中相邻点的路段耗时）
export function walkBetween(graph, from, to) {
  if (from === to) return { sec: 0, path: [] };
  const all = shortestPaths(graph, from);
  return all.get(to) || { sec: null, path: [] };
}

// 步行距离筛选：walkSec <= maxSec 视为在圈内；不可达不通过
export function withinWalking(sp, placeId, maxSec) {
  const hit = sp.get(placeId);
  if (!hit) return { ok: false, sec: null };
  return { ok: hit.sec <= maxSec, sec: hit.sec };
}
