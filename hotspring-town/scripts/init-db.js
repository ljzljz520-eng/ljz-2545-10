// 初始化数据库结构 + 种子数据
// 用法：node scripts/init-db.js [--force]
import { initDb, closeDb } from '../src/server/db/index.js';
import { seedDb } from '../src/server/db/seed.js';
const force = process.argv.includes('--force');
await initDb();
const r = await seedDb({ force });
console.log(r.skipped ? '已存在数据，跳过（--force 可重建）' : '种子完成：', r);
await closeDb();
