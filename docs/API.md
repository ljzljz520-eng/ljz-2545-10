# API 文档

基础路径 `/api`，JSON 收发，时间一律 ISO8601（建议带 `+09:00` 或用 UTC）。BIGINT 以 JSON number 返回。

## 健康
- `GET /health` → `{ok, db, tz, time}`

## 地点与地图筛选
- `GET /places?stay&food&family&walkMeters&originLat&originLng&at`
  - 布尔参数取 `1/true`；`walkMeters` 需同时给 `originLat/originLng`；`at` 为到访时刻。
  - 返回 `included[]`、`excluded[{place,reasons[]}]`、`filter_summary`。
  - 原因码：`merged`(已合并,含 mergedInto) `too_far`(含 distance) `no_facility_match`
    `unavailable_at_time`(含每个设施的 reason/opens_later) `inactive`。
  - 每个 included 地点含展开的 `facilities[]`（泡池检修只标该设施 `maintenance[]`）与带来源的 `springs[]`。
- `GET /places/:id` → 正常 `{place}`；已合并 `{redirect:{merged_into,name}, place}`（响应头 `X-Merged-Into`）。

## 推荐（展开到设施）
- `GET /recommend` → 全部主题条目聚合去重。
- `GET /recommend/themes` → 三个原创主题。
- `GET /recommend?theme=morning_mist|family_foam|night_steam[&at=]`
  - 每条含 `place_id/place_name/facility_id/facility_name/facility_kind/why`；
    指定 `at` 时附 `status_at_time {available, code, message, opens_later, maintenance}`。

## 行程
- `GET /itineraries` / `POST /itineraries {title,theme,description,device_id}`
- `GET /itineraries/:id` → 行程 + `items[]` + 当前 `conflicts[]`（不改计划）。
- `POST /itineraries/:id/items/:itemId/lock {lock_note}` / `.../unlock`
- `POST /itineraries/:id/recompute`
  ```json
  { "mode": "full | partial",
    "startAt": "2026-10-08T00:30:00Z",
    "trigger": { "facilityIds": [12,30], "placeId": 1 } }
  ```
  返回 `mode/start_index/changed[]/conflicts[]/cache_freshness/items/log_id`。
- `POST /itineraries/:id/edits`（双设备）
  ```json
  { "device_id": "device-B", "base_version": 3,
    "op": { "type": "add|remove|move|lock|unlock", ... } }
  ```
  版本落后 → **409** `{applied:false, conflict:true, server_version, message}`；成功 → 200。
- `GET /itineraries/:id/edits` 编辑/冲突历史。
- `POST /itineraries/:id/simulate-hours-change {facility_id, source_id, hours[]}`
  验收用：修改开放时间后重算以观察“锁定保留+冲突解释”。

## 管理 / 数据治理
- `POST /admin/maintenance {facility_id,title,start_at,end_at,reason,source_id}`（支持跨日；反转 400）
- `DELETE /admin/maintenance/:id`
- `POST /admin/places/:oldId/merge/:keepId` 地点合并（设施/别名/步行边/行程引用迁移，旧点置 merged）
- `PATCH /admin/places/:id/verification {needs_verification,note}`
- `GET /admin/sources` / `POST /admin/sources/:id/check` 链接巡检（200→active；410→dead；网络失败→stale/dead）
- `POST /admin/opening-hours/facility/:facilityId {source_id,hours[]}`
- `POST /admin/walking-edges {from_place,to_place,distance_m,duration_s,source_id}`（更新即失效相关缓存）
- `GET /admin/offline` → `packages[] {state: current|expired|inactive, message}`

## 冲突码（行程）
| code | 含义 |
|---|---|
| `locked_closed_conflict` | 锁定点落在闭馆时段；点保留不移动 |
| `locked_maintenance_conflict` | 锁定点撞上检修；点保留不移动 |
| `hours_changed_after_lock` | 锁定后开放时间表变化；附锁定时/现在时表对照 |
| `no_feasible_slot` | 可达后 12h 内无可用时窗；点保留待人工处理 |
| `no_anchor` | 缺少起始时间锚点 |

## 错误形态
`400` 参数错误 / `404` 不存在 / `409` 版本冲突或重复合并 / `503` 数据库不可用，体 `{error}`。
