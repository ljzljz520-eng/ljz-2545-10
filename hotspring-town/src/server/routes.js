import { Router } from 'express';
import * as guide from './services/guide-service.js';
import * as itin from './services/itinerary-service.js';
import * as srcSvc from './services/source-service.js';
import * as offline from './services/offline-service.js';
import * as repo from './repo/repo.js';
import { combineSlots } from './engine/itinerary.js';
import { buildWorld } from './engine/filter.js';
import { readFile } from 'node:fs/promises';
import { designNotes } from './content/design-notes.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sendOr404(res, value) {
  if (!value) return res.status(404).json({ error: 'not found' });
  res.json(value);
}

export function registerRoutes(app) {
  const api = Router();
  app.use('/api', api);

  api.get('/town', async (_req, res) => {
    const data = JSON.parse(await readFile(join(__dirname, '../../data/seed.json'), 'utf8'));
    res.json({ town: data.town });
  });

  api.get('/design', (_req, res) => res.json(designNotes));

  // ---------- 地图 / 筛选 ----------
  api.get('/places', async (req, res) => {
    const q = req.query;
    const filters = {
      date: q.date || undefined,
      kinds: q.kinds ? String(q.kinds).split(',').filter(Boolean) : [],
      familyOnly: q.family === '1' || q.family === 'true',
      originPlaceId: q.origin || null,
      maxWalkSec: q.maxWalkMin ? Math.round(Number(q.maxWalkMin) * 60) : null,
    };
    res.json(await guide.searchPlaces(filters));
  });

  api.get('/places/:id', async (req, res) => {
    sendOr404(res, await repo.placeDetail(req.params.id));
  });

  api.get('/facilities/:id', async (req, res) => {
    sendOr404(res, await guide.facilityDetail(req.params.id, req.query.date));
  });

  api.get('/recommendations', async (req, res) => {
    res.json({ themes: await guide.recommendations({ date: req.query.date, theme: req.query.theme }) });
  });

  // ---------- 可访问时间段组合 ----------
  api.get('/slots', async (req, res) => {
    const ids = String(req.query.facilities || '').split(',').filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'facilities required' });
    const world = buildWorld(await repo.loadWorld());
    const ctx = {
      date: req.query.date,
      startPlaceId: req.query.origin || 'p_station',
    };
    res.json(combineSlots(world, ids, ctx));
  });

  // ---------- 行程 ----------
  api.post('/itineraries', async (req, res) => {
    const { title, visitDate, startPlaceId, deviceId } = req.body || {};
    if (!visitDate) return res.status(400).json({ error: 'visitDate required' });
    const id = await repo.createItinerary({
      title: title || '柚木沢プラン', visitDate,
      startPlaceId: startPlaceId || 'p_station', deviceId,
    });
    res.status(201).json({ id });
  });
  api.get('/itineraries', async (_req, res) => res.json({ itineraries: await repo.listItineraries() }));
  api.get('/itineraries/:id', async (req, res) => sendOr404(res, await repo.getItinerary(req.params.id)));
  api.get('/itineraries/:id/events', async (req, res) =>
    res.json({ events: await repo.listEvents(req.params.id) }));

  api.post('/itineraries/:id/recompute', async (req, res) => {
    const out = await itin.recompute(req.params.id, { deviceId: req.body?.deviceId });
    sendOr404(res, out);
  });
  api.post('/itineraries/:id/repair', async (req, res) => {
    const out = await itin.repair(req.params.id, req.body?.changes || {}, { deviceId: req.body?.deviceId });
    sendOr404(res, out);
  });
  api.put('/itineraries/:id/items', async (req, res) => {
    const { items, expectedVersion, action, deviceId, lockChanges } = req.body || {};
    if (!Array.isArray(items) || expectedVersion == null) {
      return res.status(400).json({ error: 'items[] and expectedVersion required' });
    }
    const out = await itin.editItems(req.params.id, items, {
      deviceId, expectedVersion, action: action || 'edit', lockChanges: lockChanges || [],
    });
    if (out.error) return res.status(out.status || 400).json(out);
    res.json(out);
  });

  // ---------- 管理：维护 / 合并 / 来源 / 离线包 ----------
  api.get('/admin/maintenance', async (req, res) => {
    res.json({ maintenance: await repo.listMaintenance({ futureOnly: req.query.future === '1', date: req.query.date }) });
  });
  api.post('/admin/maintenance', async (req, res) => {
    const b = req.body || {};
    if (!b.title || !b.start_at || !b.end_at) return res.status(400).json({ error: 'title/start_at/end_at required' });
    if (!b.facility_id && !b.place_id) return res.status(400).json({ error: 'facility_id or place_id required' });
    const id = await repo.createMaintenance(b);
    res.status(201).json({ id });
  });

  api.put('/admin/windows/:id', async (req, res) => {
    const b = req.body || {};
    if (b.facilityId == null || b.dow == null || b.openMin == null || b.closeMin == null) {
      return res.status(400).json({ error: 'facilityId,dow,openMin,closeMin required' });
    }
    res.json(await repo.setWeeklyWindow({
      id: req.params.id, facilityId: b.facilityId, dow: b.dow,
      openMin: b.openMin, closeMin: b.closeMin, note: b.note ?? null,
    }));
  });
  api.post('/admin/date-windows', async (req, res) => {
    const b = req.body || {};
    if (!b.id || !b.facilityId || !b.calDate) return res.status(400).json({ error: 'id,facilityId,calDate required' });
    res.json(await repo.upsertDateWindow({
      id: b.id, facilityId: b.facilityId, calDate: b.calDate,
      openMin: b.openMin ?? null, closeMin: b.closeMin ?? null,
      closed: !!b.closed, note: b.note ?? null,
    }));
  });

  api.post('/admin/places/merge', async (req, res) => {
    const { keptId, removedId, reason, deviceId } = req.body || {};
    if (!keptId || !removedId) return res.status(400).json({ error: 'keptId/removedId required' });
    try {
      res.json(await repo.mergePlaces(keptId, removedId, { reason, deviceId }));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  api.get('/sources', async (_req, res) => res.json({ sources: await srcSvc.sourcesList() }));
  api.post('/sources/check', async (req, res) =>
    res.json(await srcSvc.checkAllLinks({ useNetwork: req.body?.useNetwork === true })));

  api.get('/offline/latest', async (_req, res) => {
    const pkg = await offline.fetchPackage(null);
    if (!pkg) return res.status(404).json({ error: 'no package published' });
    res.json(pkg);
  });
  api.get('/offline/:id', async (req, res) => sendOr404(res, await offline.fetchPackage(req.params.id)));
  api.post('/admin/offline/publish', async (req, res) => {
    const b = req.body || {};
    const ttlDays = b.ttlDays ?? 30;
    const versionTag = b.versionTag || `pack-${new Date().toISOString().slice(0, 10)}`;
    res.status(201).json(await offline.snapshotPackage({ versionTag, ttlDays, includeItinerary: !!b.includeItinerary }));
  });
}
