# ♨️ 云麓温泉町导览（Onsen Town Guide）

地图筛选（住宿 / 餐饮 / 步行距离 / 亲子设施）、设施级推荐、行程可组合时窗、
手工锁定与冲突解释、PostgreSQL 单一事实源、双设备并发与离线包治理。

- 数据与后端：Node.js 20 + Express + PostgreSQL（`pg`）
- 前端：Leaflet + 原生 JS/CSS（无构建步骤，Leaflet 已 vendored）
- 原创主题：晨雾逐汤 / 泡泡亲子半日 / 夜蒸小吃线
- 原创站内视觉：「湯けむり · 五感散步」

## 快速开始

```bash
# 方式一：docker compose（含 PG，首次自动建表+种子）
docker compose up -d --build

# 方式二：本地（无需 root，嵌入式 PG）
npm install
node scripts/dev-pg.js     # 终端1
node scripts/init-db.js    # 终端2
npm run dev                # 终端3 → http://localhost:3000
```

## 核心约束（对应验收）

- 部分泡池检修只让该泡池不可用，同馆餐饮/住宿不连坐；推荐展开到具体设施。
- 泉质是带来源的描述，禁医疗功效词，出口附免责声明。
- 锁定行程点后开放时间/检修变化：**保留锁定 + 解释冲突，绝不偷偷换点**。
- 完整重算与按依赖局部修复共用同一路段缓存与时间窗算法，结果一致；
  审计路段耗时、服务时窗、缓存 TTL/失效。
- 维护支持跨日；链接失效巡检留痕；地点合并迁移设施/别名/边/行程引用；
  过期离线包显式 expired；两台设备版本冲突返回 409 且不互相覆盖。
- 页面逐条说明过滤原因，并以「核」印戳区分待核信息。

## 测试

```bash
npm test   # 38 用例：时窗、筛选不连坐、推荐、调度一致性、锁定、合并、链接、离线、双设备、缓存
```

文档：[设计](docs/DESIGN.md) · [API](docs/API.md) · [部署](docs/DEPLOY.md)
