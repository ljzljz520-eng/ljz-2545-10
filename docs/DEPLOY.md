# 部署文档

## 方式 A：Docker Compose（推荐，含 PostgreSQL 16）

```bash
cp .env.example .env          # 按需修改
docker compose up -d --build
# 首次启动自动执行 db/schema.sql + db/seed.sql
open http://localhost:3000
```

- API: http://localhost:3000 （静态前端 + JSON API 同域）
- Postgres: 127.0.0.1:55432（用户/库均为 onsen）
- 数据卷：`onsen-pg`

健康检查：`curl localhost:3000/api/health`

> 生产环境请修改数据库口令，并通过反向代理（nginx/Caddy）终止 TLS。
> 重置演示数据：`docker compose exec api node scripts/init-db.js`（默认 DROP&CREATE public schema）。

## 方式 B：自备 PostgreSQL

```bash
createdb onsen
export DATABASE_URL=postgres://USER:PASS@HOST:5432/onsen
npm ci --omit=dev
node scripts/init-db.js        # 初始化表与种子
node src/server.js             # 默认 3000
```

## 方式 C：本地开发（无 root / 无系统 PG）

仓库内置 `embedded-postgres`（devDependency，按平台自动取二进制）：

```bash
npm install
node scripts/dev-pg.js         # 终端 1：在 55432 启动嵌入式 PG
node scripts/init-db.js        # 终端 2：建表+种子
npm run dev                    # 终端 3：启动 API（node --watch）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgres://onsen:onsen@127.0.0.1:55432/onsen` | PG 连接串 |
| `PORT` | `3000` | API 端口 |
| `TZ_NAME` | `Asia/Tokyo` | 时窗解释时区 |
| `WALK_SPEED_MPS` | `1.25` | 无实测/路由数据时的步行速度 |
| `SEGMENT_TTL_MS` | `86400000` | 路段缓存 TTL |
| `OSRM_BASE_URL` | 空 | 配置后优先用 OSRM foot 路由；超时/失败自动回退 |

## 步行耗时来源与缓存新鲜度

`measured`（实地测量边）> `osrm`（可选路由服务）> `haversine`（直线 × 步速）。
结果写 `segment_cache` 并带 `expires_at`；步行边更新/地点合并会双向 `invalid` 相关条目。
`POST /api/itineraries/:id/recompute` 的响应与 `itinerary_recompute_log` 均含 `cache_freshness`。

## 离线包

`GET /api/admin/offline` 始终显式区分 `current / expired / inactive`。
前端在启动时检查：若最新包 `state==='expired'`，提示重新下载，不静默使用旧数据。

## 测试

```bash
npm test     # 38 个用例：时窗/筛选不连坐/推荐/调度一致性/锁定冲突/合并/链接/离线/双设备/缓存
```

测试每个文件独立进程拉起一个临时嵌入式 PG（55433-55435 段），无需外部服务。

## 目录

```
db/            schema.sql / seed.sql
src/
  db/pool.js
  util/time.js            绝对时间/跨日时窗/检修交集/最早可行段
  services/catalog.js     地图筛选+过滤原因+设施展开+泉质
  services/recommend.js   三个原创主题（设施级推荐）
  services/segments.js    路段耗时与缓存新鲜度
  services/scheduler.js   full/partial 重算 + 锁定冲突
  services/sync.js        双设备乐观并发
  services/admin.js       维护/合并/链接巡检/待核/离线包/时表/步行边
  routes/ server.js
public/        index.html styles.css app.js vendor/leaflet*
test/          01..07 验收测试
docs/          DESIGN.md API.md DEPLOY.md
```
