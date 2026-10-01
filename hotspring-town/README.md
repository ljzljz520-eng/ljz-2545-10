# ♨ 柚木沢温泉郷 まち歩きガイド（温泉小镇导览产品）

面向温泉小镇的一站式导览：**地图筛选**（住宿 / 餐饮 / 步行距离 / 亲子设施）、
**行程 API**（可访问时间段组合）、**PostgreSQL 数据管理**（地点 / 设施 / 维护 / 来源记录）。

- 某场馆一个泡池检修，**不会**让同馆餐饮、住宿从地图消失；推荐条目会**展开到用户真正要去的设施**。
- 泉质是**带来源的描述信息**，不做任何医疗功效推断；链接失效自动降级为「要确认」。
- 手工锁定的行程点，开放时间变化后**保留锁定并解释冲突**，绝不偷偷换点。
- 同时实现**完整重算**与**按依赖的局部修复**，保证路段耗时 / 服务时窗 / 缓存新鲜度一致。

> 数据为虚构小镇「柚木沢温泉郷」（UTC+9），全部原创演示数据。

## 快速开始（零安装：内置内存 PG）

```bash
npm install            # 已有 node_modules（express/pg/pg-mem）可跳过
npm start              # http://localhost:3000
# 浏览器打开后：地图筛选 / 我的行程 / 推荐 / 管理・出典 / 设计 五个页签
```

不设置 `DATABASE_URL` 时使用 [pg-mem](https://github.com/oguimbal/pg-mem)（内存 PostgreSQL），
**无需安装数据库**即可体验与验收；设置 `DATABASE_URL` 后切换到真实 PostgreSQL，代码路径一致。

## 用真实 PostgreSQL（可部署后端）

```bash
docker compose up -d --build     # 启动 postgres:16 + app，自动建表
# 或手动：
DATABASE_URL=postgres://guide:guide@localhost:5432/hotspring npm run init-db
DATABASE_URL=postgres://guide:guide@localhost:5432/hotspring npm start
```

真实 PG 的冒烟测试（参数绑定 / jsonb / timestamptz / 跨夜 CHECK）：`npm run test:pg`

## 验收（49 项端到端检查）

```bash
npm start &                 # 先起服务
npm run acceptance          # 另一个终端：跨日维护/链接失效/地点合并/过期离线包/双设备编辑…
npm test                    # 引擎14 + API9 共24项 node:test
```

覆盖的验收场景：维护跨日、链接失效、地点合并、过期离线包、两个设备编辑同一行程、
页面说明过滤原因与待核信息、原创主题、站内设计说明、可部署后端。

## 目录

```
src/server/db        schema.sql（PG）/ pg-mem 双后端 / 种子
src/server/engine    walking 步行最短路 · availability 时窗与维护
                     filter 地图筛选 · itinerary 完整重算/局部修复/依赖指纹
src/server/repo      SQL（补偿事务，兼容 pg-mem 与真实 PG）
src/server/services  行程 / 向导 / 来源核查 / 离线包
src/server/content   站内设计说明
web                  原创温泉街主题界面（内联 SVG 地图，无外部 CDN）
data/seed.json       虚构小镇数据
scripts/acceptance.py 端到端验收脚本
docs/                DESIGN.md（详细设计）
```

## 两个设备编辑

行程带 `version` 乐观锁：`PUT /api/itineraries/:id/items` 必须带 `expectedVersion`，
过期保存返回 **409 version_conflict** 与当前版本；界面顶部可在「📱 スマホA / B」间切换模拟。
所有编辑写入 `itinerary_events`（设备、版本、操作类型）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 留空用内置 pg-mem；设置则用真实 PostgreSQL |
| `TOWN_TZ` | 小镇时区，默认 `UTC+9` |
| `PORT` | 监听端口，默认 3000 |
| `SERVER_NOW` | 注入当前时间（仅验收跨日场景） |

设计细节见 [`docs/DESIGN.md`](docs/DESIGN.md)。
