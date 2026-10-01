// 本地验收用嵌入式 PG（生产用 docker-compose 的官方 postgres 镜像）
// 幂等：数据目录已初始化时直接启动，不再跑 initdb。
const path = require('path');
const fs = require('fs');
const pkg = require('embedded-postgres');
const Embedded = pkg.default || pkg;
const dataDir = process.env.PG_DATA_DIR || path.join('/tmp', 'onsen-pgdata');
fs.mkdirSync(dataDir, { recursive: true });
const pg = new Embedded({
  databaseDir: dataDir,
  user: 'onsen', password: 'onsen', port: Number(process.env.PG_PORT || 55432),
  persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'],
});
(async () => {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();
  if (!fs.existsSync(path.join(dataDir, 'db_initialized'))) {
    try { await pg.createDatabase('onsen'); } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
    fs.writeFileSync(path.join(dataDir, 'db_initialized'), '1');
  }
  console.log(`embedded pg ready on port ${pg.port || process.env.PG_PORT || 55432}`);
})().catch((e) => { console.error(e); process.exit(1); });
