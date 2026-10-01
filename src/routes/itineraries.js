const express = require('express');
const scheduler = require('../services/scheduler');
const sync = require('../services/sync');
const admin = require('../services/admin');
const pool = require('../db/pool');
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id,title,theme,description,version,updated_at FROM itinerary ORDER BY id');
    res.json({ itineraries: rows });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { title, theme, description, device_id } = req.body || {};
    const { rows } = await pool.query(
      'INSERT INTO itinerary (title,theme,description,device_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [title || '未命名行程', theme || null, description || null, device_id || null]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { itinerary, items } = await scheduler.load(req.params.id);
    const conflicts = await scheduler.detectConflicts(req.params.id, req.app.locals.tz);
    res.json({ ...itinerary, items: scheduler.serialize(items), conflicts });
  } catch (e) { next(e); }
});

// 手工锁定 / 解锁
router.post('/:id/items/:itemId/lock', async (req, res, next) => {
  try {
    const { items } = await scheduler.load(req.params.id);
    const item = items.find(i => i.id === Number(req.params.itemId));
    if (!item) return res.status(404).json({ error: '行程点不存在' });
    item.lock_note = req.body?.lock_note;
    const snap = await scheduler.lockItem(item);
    const conflicts = await scheduler.detectConflicts(req.params.id, req.app.locals.tz);
    res.json({ locked: item.id, locked_window: snap, conflicts,
      notice: '已锁定。此后开放时间或检修变化不会移动该点，系统只报告冲突。' });
  } catch (e) { next(e); }
});

router.post('/:id/items/:itemId/unlock', async (req, res, next) => {
  try {
    await pool.query('UPDATE itinerary_item SET manual_lock=FALSE, locked_window=NULL, lock_note=NULL WHERE id=$1 AND itinerary_id=$2',
      [req.params.itemId, req.params.id]);
    res.json({ unlocked: Number(req.params.itemId) });
  } catch (e) { next(e); }
});

// 重算：POST /:id/recompute {mode:'full'|'partial', trigger, startAt}
router.post('/:id/recompute', async (req, res, next) => {
  try {
    const mode = req.body?.mode === 'partial' ? 'partial' : 'full';
    const r = await scheduler.recompute(req.params.id, {
      mode, trigger: req.body?.trigger || null,
      startAt: req.body?.startAt || null, tz: req.app.locals.tz,
    });
    res.json(r);
  } catch (e) { next(e); }
});

// 设备编辑：POST /:id/edits {device_id, base_version, op}
router.post('/:id/edits', async (req, res, next) => {
  try {
    const { device_id, base_version, op } = req.body || {};
    if (!device_id || base_version == null || !op) {
      return res.status(400).json({ error: '需要 device_id, base_version, op' });
    }
    const r = await sync.submitEdit(req.params.id, device_id, Number(base_version), op);
    res.status(r.applied ? 200 : 409).json(r);
  } catch (e) { next(e); }
});

router.get('/:id/edits', async (req, res, next) => {
  try { res.json({ edits: await sync.editHistory(req.params.id) }); }
  catch (e) { next(e); }
});

// 便捷：模拟“锁定后开放时间改变”，随后可重算验证冲突保留
router.post('/:id/simulate-hours-change', async (req, res, next) => {
  try {
    const facilityId = req.body?.facility_id;
    const hours = req.body?.hours;
    if (!facilityId || !Array.isArray(hours) || !hours.length) {
      return res.status(400).json({ error: '需要 facility_id 与 hours[]' });
    }
    const out = await admin.replaceHours(facilityId, hours, req.body?.source_id);
    res.json({ updated_facility: facilityId, opening_hours: out,
      note: '开放时间已更新。锁定点不会移动；调用 /recompute 可查看冲突说明。' });
  } catch (e) { next(e); }
});

module.exports = router;
