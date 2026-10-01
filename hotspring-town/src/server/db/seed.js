import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function seedDb({ force = false, seedPath } = {}) {
  const pool = await getPool();
  const path = seedPath || join(__dirname, '../../../data/seed.json');
  const data = JSON.parse(await readFile(path, 'utf8'));

  if (force) {
    // pg-mem 不支持多表 TRUNCATE，按子→父顺序 DELETE（真实 PG 同样有效）
    for (const t of ['offline_packages','itinerary_events','itinerary_items','itineraries',
      'walking_edges','maintenance','date_windows','service_windows','spring_quality',
      'facilities','place_merges','sources','places']) {
      await pool.query(`DELETE FROM ${t}`);
    }
  } else {
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM places`);
    if (rows[0].c > 0) return { skipped: true, ...counts(pool) };
  }

  for (const p of data.places) {
    await pool.query(
      `INSERT INTO places(id,name,kind,lat,lng,address,phone,home_url,family_friendly,description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, p.name, p.kind, p.lat, p.lng, p.address ?? null, p.phone ?? null,
       p.home_url ?? null, !!p.family_friendly, p.description ?? null]);
  }
  for (const f of data.facilities) {
    await pool.query(
      `INSERT INTO facilities(id,place_id,name,kind,lat,lng,family_friendly,family_attrs,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [f.id, f.place_id, f.name, f.kind, f.lat ?? null, f.lng ?? null,
       !!f.family_friendly, JSON.stringify(f.family_attrs || []), f.note ?? null]);
  }
  for (const s of data.spring_quality) {
    await pool.query(
      `INSERT INTO spring_quality(facility_id,source_text,temperature_c,claims,source_id,verified)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.facility_id, s.source_text, s.temperature_c ?? null,
       JSON.stringify(s.claims || []), s.source_id ?? null, !!s.verified]);
  }
  for (const w of data.windows) {
    await pool.query(
      `INSERT INTO service_windows(id,facility_id,dow,open_min,close_min)
       VALUES ($1,$2,$3,$4,$5)`,
      [w.id, w.facility_id, w.dow, w.open, w.close]);
  }
  for (const d of data.date_windows || []) {
    await pool.query(
      `INSERT INTO date_windows(id,facility_id,cal_date,open_min,close_min,closed,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [d.id, d.facility_id, d.cal_date, d.open_min ?? null, d.close_min ?? null,
       !!d.closed, d.note ?? null]);
  }
  for (const m of data.maintenance) {
    await pool.query(
      `INSERT INTO maintenance(id,facility_id,place_id,title,start_at,end_at,status,note,source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.id, m.facility_id, m.place_id ?? null, m.title, m.start, m.end, m.status,
       m.note ?? null, m.source_id ?? null]);
  }
  for (const s of data.sources) {
    await pool.query(
      `INSERT INTO sources(id,title,url,kind,fetched_at,last_ok_at,http_status,link_state,trust)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, s.title, s.url ?? null, s.kind, s.fetched_at ?? null, s.last_ok_at ?? null,
       s.http_status ?? null, s.link_state, s.trust]);
  }
  for (const e of data.edges) {
    await pool.query(
      `INSERT INTO walking_edges(id,from_place,to_place,walk_sec,path_kind,note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.id, e.from, e.to, e.sec, e.kind, e.note ?? null]);
  }
  return { skipped: false, ...(await counts(pool)) };
}

async function counts(pool) {
  const get = async (t) => (await pool.query(`SELECT count(*)::int c FROM ${t}`)).rows[0].c;
  return {
    places: await get('places'), facilities: await get('facilities'),
    windows: await get('service_windows'), maintenance: await get('maintenance'),
    sources: await get('sources'), edges: await get('walking_edges'),
  };
}
