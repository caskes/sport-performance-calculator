import { Hono } from 'hono';
import { parseFile, resampleTo100m } from './lib/gpx-parser';
import {
  DailyMetric,
  UpcomingEvent,
  computeTrainingState,
  computeBaselineHRV,
  estimateTSS,
  eventAdvisory,
} from './lib/training-brain';
import { FitnessIntake, GoalSelection } from './lib/gap-analysis';
import appHtml from './index.html';

export interface Env {
  APP_NAME: string;
  ATHLETE_KV: KVNamespace;
  SYNC_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ─── UI ────────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(appHtml));

// ─── API: parse GPX/KML → raw 100 m intervals ──────────────────────────────────

app.post('/api/parse', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);
    const sizeLimit = 10 * 1024 * 1024;
    if (file.size > sizeLimit) return c.json({ error: 'File too large (max 10 MB)' }, 400);
    const content = await file.text();
    const points = parseFile(content, file.name);
    const intervals = resampleTo100m(points);
    return c.json({ filename: file.name, total_points: points.length, intervals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Processing error';
    return c.json({ error: msg }, 400);
  }
});

// ─── API: sync health data from iOS Shortcut ───────────────────────────────────

app.post('/api/sync-health', async (c) => {
  // Optional token auth
  const token = c.env.SYNC_TOKEN;
  if (token) {
    const provided = c.req.header('X-Sync-Token') ?? c.req.query('token');
    if (provided !== token) return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: DailyMetric;
  try {
    body = await c.req.json<DailyMetric>();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' }, 400);
  }

  const ftp = parseInt((await c.env.ATHLETE_KV.get('athlete:ftp')) ?? '200');
  const tss = estimateTSS(body, ftp);
  const record: DailyMetric = { ...body, tss };

  await c.env.ATHLETE_KV.put(`health:${body.date}`, JSON.stringify(record));

  // Recompute training state
  const metrics = await loadMetrics(c.env.ATHLETE_KV);
  const events  = await loadEvents(c.env.ATHLETE_KV);
  const state   = computeTrainingState(metrics, ftp);
  const advisory = eventAdvisory(events, state);

  return c.json({ ok: true, tss, state, advisory });
});

// ─── API: get dashboard data ───────────────────────────────────────────────────

app.get('/api/dashboard', async (c) => {
  const ftp     = parseInt((await c.env.ATHLETE_KV.get('athlete:ftp')) ?? '200');
  const metrics = await loadMetrics(c.env.ATHLETE_KV);
  const events  = await loadEvents(c.env.ATHLETE_KV);

  if (metrics.length === 0) {
    return c.json({ metrics: [], events, state: null, advisory: [] });
  }

  const state    = computeTrainingState(metrics, ftp);
  const advisory = eventAdvisory(events, state);

  // Return last 90 days for sparkline
  const recent = metrics.slice(-90).map(m => ({
    date: m.date,
    tss: m.tss ?? 0,
    hrv_ms: m.hrv_ms,
    sleep_hours: m.sleep_hours,
    weight_kg: m.weight_kg,
    vo2_max: m.vo2_max,
  }));

  return c.json({ metrics: recent, events, state, advisory, ftp });
});

// ─── API: save athlete profile (FTP etc.) ─────────────────────────────────────

app.post('/api/athlete', async (c) => {
  const body = await c.req.json<{ ftp?: number; name?: string }>();
  if (body.ftp) await c.env.ATHLETE_KV.put('athlete:ftp', String(body.ftp));
  if (body.name) await c.env.ATHLETE_KV.put('athlete:name', body.name);
  return c.json({ ok: true });
});

// ─── API: events CRUD ─────────────────────────────────────────────────────────

app.get('/api/events', async (c) => {
  const events = await loadEvents(c.env.ATHLETE_KV);
  return c.json(events);
});

app.post('/api/events', async (c) => {
  const ev = await c.req.json<UpcomingEvent>();
  if (!ev.id || !ev.name || !ev.date || !ev.sport) {
    return c.json({ error: 'Missing required fields: id, name, date, sport' }, 400);
  }
  const events = await loadEvents(c.env.ATHLETE_KV);
  const idx = events.findIndex(e => e.id === ev.id);
  if (idx >= 0) events[idx] = ev; else events.push(ev);
  await c.env.ATHLETE_KV.put('events', JSON.stringify(events));
  return c.json({ ok: true, events });
});

app.delete('/api/events/:id', async (c) => {
  const id = c.req.param('id');
  const events = (await loadEvents(c.env.ATHLETE_KV)).filter(e => e.id !== id);
  await c.env.ATHLETE_KV.put('events', JSON.stringify(events));
  return c.json({ ok: true });
});

// ─── API: store GPX intervals for an event ────────────────────────────────────

app.post('/api/events/:id/gpx', async (c) => {
  const id = c.req.param('id');
  const events = await loadEvents(c.env.ATHLETE_KV);
  const idx = events.findIndex(e => e.id === id);
  if (idx < 0) return c.json({ error: 'Event not found' }, 404);

  const body = await c.req.json<{ intervals: unknown[] }>();
  if (!body.intervals || !Array.isArray(body.intervals)) {
    return c.json({ error: 'intervals array required' }, 400);
  }
  await c.env.ATHLETE_KV.put(`event-gpx:${id}`, JSON.stringify(body.intervals));

  // Mark event as having a GPX so the UI can show the open-in-analyzer button
  events[idx] = { ...events[idx], has_gpx: true };
  await c.env.ATHLETE_KV.put('events', JSON.stringify(events));

  return c.json({ ok: true, count: body.intervals.length });
});

app.get('/api/events/:id/gpx', async (c) => {
  const id = c.req.param('id');
  const raw = await c.env.ATHLETE_KV.get(`event-gpx:${id}`);
  if (!raw) return c.json({ error: 'No GPX data for this event' }, 404);
  return c.json({ intervals: JSON.parse(raw) });
});

// ─── API: fitness intake from manual form or Apple Shortcut ───────────────────

app.post('/api/fitness-intake', async (c) => {
  const token = c.env.SYNC_TOKEN;
  if (token) {
    const provided = c.req.header('X-Sync-Token') ?? c.req.query('token');
    if (provided !== token) return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: FitnessIntake;
  try {
    body = await c.req.json<FitnessIntake>();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' }, 400);
  }
  if (!body.sport || !body.effort_distance_km || !body.effort_time_min ||
      !body.weekly_hours || !body.longest_session_h || !body.fatigue_level || !body.age) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  await c.env.ATHLETE_KV.put('fitness-intake:latest', JSON.stringify(body));
  return c.json({ ok: true, source: body.source });
});

app.get('/api/fitness-intake', async (c) => {
  const raw = await c.env.ATHLETE_KV.get('fitness-intake:latest');
  if (!raw) return c.json({ error: 'No fitness intake data' }, 404);
  return c.json(JSON.parse(raw) as FitnessIntake);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadMetrics(kv: KVNamespace): Promise<DailyMetric[]> {
  const list = await kv.list({ prefix: 'health:' });
  const metrics: DailyMetric[] = [];
  await Promise.all(
    list.keys.map(async (k) => {
      const val = await kv.get(k.name);
      if (val) metrics.push(JSON.parse(val) as DailyMetric);
    }),
  );
  return metrics.sort((a, b) => a.date.localeCompare(b.date));
}

async function loadEvents(kv: KVNamespace): Promise<UpcomingEvent[]> {
  const raw = await kv.get('events');
  return raw ? (JSON.parse(raw) as UpcomingEvent[]) : [];
}

export default app;
