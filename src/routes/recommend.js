const express = require('express');
const { recommend, THEMES } = require('../services/recommend');
const router = express.Router();

router.get('/themes', async (req, res) => {
  res.json({ themes: Object.values(THEMES).map(t => ({ key: t.key, title: t.title, narrative: t.narrative })) });
});

// GET /api/recommend?at=...&theme=family_foam
router.get('/', async (req, res, next) => {
  try {
    const r = await recommend({ at: req.query.at || null, theme: req.query.theme || null, tz: req.app.locals.tz });
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
