// 初始化：psql -f 等价实现（嵌入式 PG / 外部 PG 通用）
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  if (process.env.RESET_DB !== '0') {
    console.log('→ resetting public schema…');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  console.log('→ applying schema…');
  await pool.query(schema);
  console.log('→ applying seed…');
  await pool.query(seed);
  const { rows } = await pool.query('SELECT count(*)::int n FROM place');
  console.log(`✓ done. places=${rows[0].n}`);
  await pool.end();
}
run().catch((e) => { console.error(e); process.exit(1); });
