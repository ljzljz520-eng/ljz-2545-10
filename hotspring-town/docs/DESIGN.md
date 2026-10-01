# 设计说明 · 柚木沢温泉小镇导览

## 1. 领域模型：场馆（places）与设施（facilities）两级

用户真正“去”的是**设施**（某个泡池、某间客房、某个餐厅），而不是地图上聚合的**场馆**。
这一分层是全系统的基石：

- `places`：地图标记单位，含坐标、种类、合并重定向、亲子场所标记。
- `facilities`：挂在 places 下的最小可达单元，含亲子属性（婴儿床/尿布台/儿童菜单/浅水区…）。
- 行程点、时窗、维护、泉质全部挂在**设施**；场馆级维护会作用到其全部设施（整馆闭馆）。

由此得到“部分检修不连坐”：`f_kiri_roten`（大露天）改修，只让该设施不可用，
同馆 `f_kiri_rest`（食事処）与 `f_kiri_room`（客室）照常，场馆 `p_kiri` 仍显示并标记
`partial_maintenance`。只有场馆下匹配设施**全部**不可用时才从地图隐藏，且给出过滤原因。

## 2. 时间模型

- `service_windows(dow, open_min, close_min)`：当地分钟。`close_min ≥ 1440` 表示**跨夜**
  （营业至次日凌晨），引擎换算绝对区间时让结束落在次日。
- `date_windows`：日期覆盖（临时休业/缩短），优先于周时窗。
- 维护 `maintenance(start_at,end_at)` 可挂设施或场馆，可**跨多日**。当天可用性 =
  「当日时窗绝对区间」减去「与之相交的维护区间」，得到若干可用小区间。
  - 22:00–次日 06:30 的跨夜检修 → 次日早晨时段被裁掉、白天恢复；
  - 10-05 22:00–10-07 10:00 的跨日改修 → 10-06 全天关闭、10-07 恢复部分时段。
- 时区固定 `UTC+9`（`TOWN_TZ` 可配），日历日按小镇本地计算，与 DB 会话时区解耦。

## 3. 步行网络与“路段耗时一致”

`walking_edges` 是无向图，边权为**实测步行秒数**（含 covered/stair/park/street 差异），
比直线距离更准确。行程串联时相邻设施所属场馆之间跑 Dijkstra 最短路
（`walkBetween`），路段耗时计入下一点的最早开始。筛选“步行 X 分钟”也用同一路网，
因此地图筛选与行程排程对同一条边给出**同一耗时**（唯一事实来源）。

## 4. 泉质：只描述、不诊断

`spring_quality` 只保存：来源原文、温度、**受控描述词**（alkaline/simple_spring/colorless…）、
来源 id 与核验状态。功效词（cure/heal/treat/medical_effect…）在输出层过滤且从不入库；
每个响应附带医疗免责声明。来源链接经 `/api/sources/check` 核查：404/410 → broken，
相关泉质与待核列表（`to_verify`）提示“要再确认”，未核实信息也显式标注，不静默当真。

## 5. 行程引擎

### 5.1 排程
非锁定点：在“上一点结束 + 步行耗时”之后，于当日可用小区间中贪心选**最早能完整放入**
的区间（默认时长按设施类型：bath 60、restaurant 75、shop 30…）。无法排入则置空并给
`no_feasible_slot` 冲突，且不移动游标，后续点仍可尝试。

锁定点：完全不改动 `planned_start/planned_end`，仅计算 `conflictsForVisit`：
当日休业 / 无时窗 / 与维护重叠 / 营业时刻外。**绝不删除、绝不替换为别的设施。**

### 5.2 完整重算 vs 局部修复（一致性核心）
每个点有依赖指纹 `dep_hash = fingerprint({
  date, startPlace, facility, facilityVersion, windowsVersion, maintenanceIds,
  duration, incomingEdge{from,to,sec,path} })`。
注意指纹**不含** `graph` 对象、`computedAt`、`locked`、`planned_start` 等运行态，
否则任何重算都会误判为“变了”（开发期实际踩过该坑并修复）。

- `fullRecompute`：从第一点整体重排。
- `localRepair(changes)`：`findFirstAffected` 先按显式变更集
  （facilities/windows/maintenance/edges/places/userEdits）找首个命中点，
  再用指纹兜底；从该点起重排，之前的点**直接复用缓存时刻**。
  随后比较重排前后时刻/冲突，`affected_indexes` 只记录真正变化的点；若富余时间吸收了
  上游变化，则 `absorbed=true`、affected 为空。
- 一致性：service 层对同一世界同时跑 full 与 local，
  `assertConsistent` 逐点比较并返回 `full_equivalence`，要求 100% 相同。
  路段耗时、服务时窗、缓存（dep_hash）因此在两种路径下一致。

## 6. 并发：两个设备编辑

`itineraries.version` 乐观锁 + `SELECT ... FOR UPDATE`（真实 PG）。保存时校验
`expectedVersion`，不符返回 409 与当前版本，前端提示并重新拉取；所有变更进
`itinerary_events(device_id, version_from, version_to, kind, payload)` 可审计。

## 7. 地点合并

`mergePlaces(kept, removed)`：迁移设施（保 id 换 place_id）、迁移去重步行边
（自环删除、重复边取较短）、迁移场馆级维护与行程起点引用；旧点置 `status='merged'`
并保留 `merged_into_id`，详情接口沿链重定向并附 `redirect_chain`，审计写 `place_merges`。
旧 id 不删，历史行程与外链不会断。

## 8. 来源核查与离线包

- 来源：`sources.link_state`（ok/broken/redirect/blocked）+ http_status + fetch 时间。
  无外网时用种子内置期望状态模拟；生产可 `useNetwork:true` 发真实请求。
- 离线包：`offline_packages(content_hash, payload, expires_at)`。过期返回
  `expired:true, usable:false` 与醒目横幅，前端只读展示、不用于新编辑。

## 9. 持久层与双后端

`DATABASE_URL` 存在 → 真实 `pg.Pool`；否则 → pg-mem 内存 PG（零安装验收）。
两个 pg-mem 兼容点：不支持多表 TRUNCATE（改按依赖顺序 DELETE）；`ANY($1)` 数组绑定
在部分路径不可靠（改动态 `IN ($1,...)`）。pg-mem 协议层的 ROLLBACK 不恢复快照，
故多写操作统一用 **withCompensatingTx 补偿事务**（每步注册逆操作，失败按序补偿），
真实 PG 上等价于“先校验后写入 + 逆操作兜底”，两条部署路径行为一致。

## 10. 前端（原创温泉街主题）

内联 SVG 手绘小镇地图（河流、有盖/台阶/公园道路样式、蒸汽光晕标记），柿渋色主色板，
无任何外部 CDN/字体依赖。五个页签：地图搜索（侧栏过滤原因 + 设施展开面板）、
我的行程（锁定/重算/修复/时段组合 + 一致性提示）、主题推荐、管理出典、站内设计说明。
顶部设备切换用于演示双设备冲突；页面上明确展示过滤原因、点检影响、待核信息与免责声明。
