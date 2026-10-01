const express = require('express');
const path = require('path');
const places = require('./routes/places');
const recommend = require('./routes/recommend');
const itineraries = require('./routes/itineraries');
const admin = require('./routes/admin');

const app = express();
app.locals.tz = process.env.TZ_NAME || 'Asia/Tokyo';
app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', async (_req, res) => {
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', tz: app.locals.tz, time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

app.use('/api/places', places);
app.use('/api/recommend', recommend);
app.use('/api/itineraries', itineraries);
app.use('/api/admin', admin);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`♨️  云麓温泉町导览 http://127.0.0.1:${PORT} (TZ=${app.locals.tz})`));
}
module.exports = app;
