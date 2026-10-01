// 数据库连接：
//   DATABASE_URL 设置 -> 真实 PostgreSQL（生产/Docker 部署）
//   未设置           -> pg-mem 内存 PG（本地开发与验收测试，无需安装 PG）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newDb } from 'pg-mem';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let _pool = null;

export async function getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    _pool = new pg.Pool({ connectionString: url, max: 10 });
  } else {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    // 时区无关：引擎按本地时区计算日期，不依赖 DB now()
    _pool = new (mem.adapters.createPg().Pool)();
  }
  return _pool;
}

// pg-mem 3.0.14 的协议层 ROLLBACK 不恢复快照（已知缺陷）。
// 因此需要事务原子性的写操作统一使用 withCompensatingTx：
// 每步注册逆操作，失败时按序补偿；真实 PG 上等价于先做可预检校验再写入。
// （真实 PG 也可用 BEGIN/COMMIT；这里刻意统一代码路径，详见 docs/DESIGN.md）
export async function withCompensatingTx(fn) {
  const pool = await getPool();
  const client = await pool.connect();
  const undo = [];
  try {
    const ctx = {
      query: async (sql, params) => client.query(sql, params),
      // 注册补偿：传 {sql, params} 或 (sql, params)，必须是当前步骤的逆操作
      undo: (sqlOrObj, maybeParams) => {
        const step = typeof sqlOrObj === 'string' ? { sql: sqlOrObj, params: maybeParams } : sqlOrObj;
        undo.unshift(step);
      },
    };
    const result = await fn(ctx);
    client.release();
    return result;
  } catch (err) {
    client.release();
    for (const step of undo) {
      try { await client.query(step.sql, step.params); }
      catch { /* 补偿尽力而为；管理端合并接口还会返回 repair_hints */ }
    }
    throw err;
  }
}

export async function initDb() {
  const pool = await getPool();
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
  return pool;
}

export async function closeDb() {
  if (_pool) { await _pool.end(); _pool = null; }
}

// pg-mem 的 query 不支持参数（仅 pg 适配器支持），统一走 pool.query
export async function query(sql, params) {
  const pool = await getPool();
  return pool.query(sql, params);
}
