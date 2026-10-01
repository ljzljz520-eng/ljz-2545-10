import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb } from './db/index.js';
import { seedDb } from './db/seed.js';
import { registerRoutes } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export async function createApp({ autoSeed = true } = {}) {
  await initDb();
  if (autoSeed) await seedDb();
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  registerRoutes(app);
  app.use(express.static(join(__dirname, '../../web')));
  // SPA fallback
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(__dirname, '../../web/index.html')));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'server error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  createApp().then((app) => app.listen(port, () => {
    console.log(`♨ 柚木沢ガイド listening http://localhost:${port} (${process.env.DATABASE_URL ? 'PostgreSQL' : 'pg-mem'})`);
  }));
}
