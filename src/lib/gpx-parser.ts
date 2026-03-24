import { XMLParser } from 'fast-xml-parser';

export interface RawPoint {
  lat: number;
  lon: number;
  ele: number;
}

export interface ParsedInterval {
  d: number; // cumulative distance in meters (end of segment)
  e: number; // elevation at segment start in meters
}

// ─── Haversine distance ────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GPX Parser ───────────────────────────────────────────────────────────────

function parseGPX(xml: string): RawPoint[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName: string) => ['trkpt', 'trk', 'trkseg'].includes(tagName),
  });

  const doc = parser.parse(xml) as Record<string, unknown>;
  const gpx = doc.gpx as Record<string, unknown> | undefined;
  if (!gpx) throw new Error('Not a valid GPX file — missing <gpx> root element');

  const trkRaw = gpx.trk;
  const tracks: unknown[] = Array.isArray(trkRaw) ? trkRaw : trkRaw ? [trkRaw] : [];
  if (tracks.length === 0) throw new Error('No tracks found in GPX file');

  const points: RawPoint[] = [];

  for (const trk of tracks) {
    const t = trk as Record<string, unknown>;
    const segRaw = t.trkseg;
    const segments: unknown[] = Array.isArray(segRaw) ? segRaw : segRaw ? [segRaw] : [];

    for (const seg of segments) {
      const s = seg as Record<string, unknown>;
      const ptRaw = s.trkpt;
      const trkpts: unknown[] = Array.isArray(ptRaw) ? ptRaw : ptRaw ? [ptRaw] : [];

      for (const pt of trkpts) {
        const p = pt as Record<string, unknown>;
        const lat = parseFloat(p['@_lat'] as string);
        const lon = parseFloat(p['@_lon'] as string);
        const ele = parseFloat((p.ele as string) ?? '0') || 0;
        if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon, ele });
      }
    }
  }

  if (points.length < 2) throw new Error('GPX file has too few track points (need at least 2)');
  return points;
}

// ─── KML Parser ───────────────────────────────────────────────────────────────

function parseKML(xml: string): RawPoint[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml) as Record<string, unknown>;

  function findCoordinates(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') return null;
    const record = obj as Record<string, unknown>;
    if (typeof record['coordinates'] === 'string') return record['coordinates'];
    for (const key of Object.keys(record)) {
      const found = findCoordinates(record[key]);
      if (found) return found;
    }
    return null;
  }

  const coordStr = findCoordinates(doc);
  if (!coordStr) throw new Error('No coordinates found in KML file');

  const points: RawPoint[] = [];
  for (const triple of coordStr.trim().split(/\s+/)) {
    const parts = triple.split(',');
    if (parts.length < 2) continue;
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    const ele = parseFloat(parts[2] ?? '0') || 0;
    if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon, ele });
  }

  if (points.length < 2) throw new Error('KML file has too few coordinate points (need at least 2)');
  return points;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseFile(content: string, filename: string): RawPoint[] {
  if (filename.toLowerCase().endsWith('.kml')) return parseKML(content);
  return parseGPX(content);
}

export function resampleTo100m(points: RawPoint[]): ParsedInterval[] {
  // Build cumulative distance array
  const cumDist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversineMeters(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon,
    );
    cumDist.push(cumDist[i - 1] + d);
  }

  const totalDist = cumDist[cumDist.length - 1];
  if (totalDist < 100) throw new Error('Route is too short (< 100 m)');

  // Linear interpolation of elevation at any distance along the route
  function interpolateEle(targetDist: number): number {
    if (targetDist <= 0) return points[0].ele;
    if (targetDist >= totalDist) return points[points.length - 1].ele;

    let lo = 0, hi = cumDist.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] <= targetDist) lo = mid; else hi = mid;
    }

    const segLen = cumDist[hi] - cumDist[lo];
    if (segLen === 0) return points[lo].ele;
    const t = (targetDist - cumDist[lo]) / segLen;
    return points[lo].ele * (1 - t) + points[hi].ele * t;
  }

  const numSegments = Math.ceil(totalDist / 100);
  const intervals: ParsedInterval[] = [];

  for (let i = 0; i < numSegments; i++) {
    const endDist = Math.min((i + 1) * 100, totalDist);
    intervals.push({
      d: Math.round(endDist),
      e: Math.round(interpolateEle(i * 100) * 10) / 10,
    });
  }

  return intervals;
}
