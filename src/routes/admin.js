const express = require('express');
const admin = require('../services/admin');
const router = express.Router();

router.post('/maintenance', async (req, res, next) => {
  try { res.status(201).json(await admin.addMaintenance(req.body || {})); }
  catch (e) { next(e); }
});
router.delete('/maintenance/:id', async (req, res, next) => {
  try { res.json(await admin.removeMaintenance(req.params.id)); }
  catch (e) { next(e); }
});

router.post('/places/:oldId/merge/:keepId', async (req, res, next) => {
  try { res.json(await admin.mergePlaces(req.params.oldId, req.params.keepId)); }
  catch (e) { next(e); }
});

router.patch('/places/:id/verification', async (req, res, next) => {
  try { res.json(await admin.setVerification(req.params.id, !!req.body?.needs_verification, req.body?.note)); }
  catch (e) { next(e); }
});

router.get('/sources', async (req, res, next) => {
  try { res.json({ sources: await admin.listSources() }); } catch (e) { next(e); }
});
router.post('/sources/:id/check', async (req, res, next) => {
  try { res.json(await admin.checkLink(req.params.id)); } catch (e) { next(e); }
});

router.post('/opening-hours/facility/:facilityId', async (req, res, next) => {
  try {
    const out = await admin.replaceHours(req.params.facilityId, req.body?.hours || [], req.body?.source_id);
    res.json({ opening_hours: out });
  } catch (e) { next(e); }
});

router.post('/walking-edges', async (req, res, next) => {
  try { res.json(await admin.upsertWalkingEdge(req.body || {})); }
  catch (e) { next(e); }
});

router.get('/offline', async (req, res, next) => {
  try { res.json({ packages: await admin.offlineStatus(new Date()) }); } catch (e) { next(e); }
});

module.exports = router;
