import { Hono } from 'hono';
import { parseFile, resampleTo100m } from './lib/gpx-parser';
import appHtml from './index.html';

export interface Env {
  APP_NAME: string;
}

const app = new Hono<{ Bindings: Env }>();

// ─── UI ───────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(appHtml));

// ─── API: parse GPX/KML → raw 100 m intervals ─────────────────────────────────

app.post('/api/parse', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    const sizeLimit = 10 * 1024 * 1024; // 10 MB
    if (file.size > sizeLimit) return c.json({ error: 'File too large (max 10 MB)' }, 400);

    const content = await file.text();
    const points = parseFile(content, file.name);
    const intervals = resampleTo100m(points);

    return c.json({
      filename: file.name,
      total_points: points.length,
      intervals, // [{d: distanceM, e: elevationM}]
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Processing error';
    return c.json({ error: msg }, 400);
  }
});

export default app;
