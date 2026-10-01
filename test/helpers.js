// 测试辅助：拉起嵌入式 PG（独立端口/数据目录），初始化 schema+seed，启动 app
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

let pg, server, baseUrl;
async function setup() {
  // 同一进程内多个 test 文件联跑时，清掉 app/db 的 require 缓存
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${require('path').sep}src${require('path').sep}`)) delete require.cache[k];
  }
  const EmbeddedPkg = require('embedded-postgres');
  const Embedded = EmbeddedPkg.default || EmbeddedPkg;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onsen-test-'));
  pg = new Embedded({ databaseDir: dataDir, user: 'onsen', password: 'onsen',
    port: 55433, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('onsen');

  process.env.DATABASE_URL = 'postgres://onsen:onsen@127.0.0.1:55433/onsen';
  // pool 在设置 DATABASE_URL 后再 require
  const pool = require('../src/db/pool');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(seed);

  const app = require('../src/server');
  await new Promise((res) => { server = app.listen(55434, res); });
  baseUrl = 'http://127.0.0.1:55434';
  return { pool, base: () => baseUrl };
}

async function teardown() {
  await new Promise((r) => server.close(r));
  const pool = require('../src/db/pool');
  await pool.end();
  await pg.stop();
}

async function api(p, opts = {}) {
  const res = await fetch(baseUrl + p, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// 构造设施开放时间（周一~周日同一张表）
const dailyHours = (open, close, crosses = false) => [0,1,2,3,4,5,6].map(day_of_week =>
  ({ day_of_week, open_time: open, close_time: close, crosses_midnight: crosses }));

module.exports = { setup, teardown, api, dailyHours };
