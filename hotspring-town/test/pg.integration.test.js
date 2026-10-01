// 真实 PostgreSQL 冒烟测试（pg-mem 不参与）。
// 仅当 DATABASE_URL 指向可连通的 PG 时运行：
//   createdb hotspring && DATABASE_URL=postgres://... npm run test:pg
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  // 无 DATABASE_URL：给出明确跳过（node:test 没有 skip-env 时直接提示退出）
  console.log('跳过：未设置 DATABASE_URL（真实 PG 集成测试）。');
  process.exit(0);
}
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

before(async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  for (const t of ['offline_packages','itinerary_events','itinerary_items','itineraries','walking_edges',
    'maintenance','date_windows','service_windows','spring_quality','facilities','place_merges','sources','places']) {
    await pool.query(`DELETE FROM ${t}`);
  }
});

test('真实 PG：参数化 IN、jsonb、timestamptz、跨夜 CHECK 可用', async () => {
  await pool.query(`INSERT INTO places(id,name,kind,lat,lng) VALUES ('p_t','テスト館','onsen',36,138)`);
  await pool.query(`INSERT INTO facilities(id,place_id,name,kind,family_attrs) VALUES ('f_t','p_t','浴槽','bath',$1)`, [JSON.stringify(['baby_seat'])]);
  const f = await pool.query(`SELECT family_attrs FROM facilities WHERE id IN ($1)`, ['f_t']);
  assert.deepEqual(f.rows[0].family_attrs, ['baby_seat']);
  await pool.query(`INSERT INTO service_windows(id,facility_id,dow,open_min,close_min) VALUES ('w_t','f_t',1,900,1500)`); // 跨夜
  const w = await pool.query(`SELECT close_min FROM service_windows WHERE id='w_t'`);
  assert.equal(Number(w.rows[0].close_min), 1500);
  // CHECK 拒绝 close<=open
  await assert.rejects(() => pool.query(
    `INSERT INTO service_windows VALUES ('w_bad','f_t',2,1200,600)`), /check|violates/i);
  await pool.end();
});
