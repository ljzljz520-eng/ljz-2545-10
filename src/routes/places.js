const express = require('express');
const catalog = require('../services/catalog');
const router = express.Router();

// GET /api/places?stay=1&food=1&family=1&walkMeters=800&originLat=&originLng=&at=
router.get('/', async (req, res, next) => {
  try {
    const q = req.query;
    const filters = {
      stay: q.stay === '1' || q.stay === 'true',
      food: q.food === '1' || q.food === 'true',
      family: q.family === '1' || q.family === 'true',
      walkMeters: q.walkMeters ? Number(q.walkMeters) : undefined,
      origin: q.originLat && q.originLng ? { lat: Number(q.originLat), lng: Number(q.originLng) } : undefined,
      at: q.at || null,
    };
    if (filters.walkMeters != null && !filters.origin) {
      return res.status(400).json({ error: '步行距离筛选需要 originLat/originLng 出发点' });
    }
    const result = await catalog.search(filters, req.app.locals.tz);
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await catalog.getPlace(req.params.id);
    if (!r) return res.status(404).json({ error: '地点不存在' });
    if (r.redirect) res.setHeader('X-Merged-Into', r.redirect.merged_into);
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
