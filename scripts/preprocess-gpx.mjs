import { readFileSync, writeFileSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGpx(content) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(content);
  const gpx = doc.gpx;
  const pts = [];
  const trk = Array.isArray(gpx.trk) ? gpx.trk[0] : gpx.trk;
  if (trk) {
    const segs = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
    for (const seg of segs) {
      if (!seg?.trkpt) continue;
      const trkpts = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
      for (const pt of trkpts) {
        const ele = parseFloat(pt.ele ?? 0);
        if (isNaN(ele)) continue;
        pts.push({ lat: parseFloat(pt['@_lat']), lon: parseFloat(pt['@_lon']), ele });
      }
    }
  }
  return pts;
}

function resampleTo100m(pts) {
  if (pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  }
  const total = cum[cum.length - 1];
  const result = [];
  let j = 0;
  for (let d = 0; d <= total; d += 100) {
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const t = cum[j + 1] > cum[j] ? (d - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    result.push({ d: Math.round(d), e: Math.round((pts[j].ele + (pts[j + 1].ele - pts[j].ele) * t) * 10) / 10 });
  }
  return result;
}

const files = [
  { id: 'livigno',      input: 'src/assets/livigno-granfondo.gpx',  output: 'src/assets/livigno-intervals.json' },
  { id: 'nyc-marathon', input: 'src/assets/nyc-marathon.gpx',        output: 'src/assets/nyc-marathon-intervals.json' },
];

for (const { id, input, output } of files) {
  console.log(`\nParsing ${id}...`);
  const content = readFileSync(input, 'utf-8');
  const pts = parseGpx(content);
  console.log(`  Trackpoints: ${pts.length}`);
  const intervals = resampleTo100m(pts);
  const totalKm  = (intervals.at(-1)?.d ?? 0) / 1000;
  const eles     = intervals.map(i => i.e);
  const gain     = eles.reduce((s, e, i) => s + (i > 0 && e > eles[i - 1] ? e - eles[i - 1] : 0), 0);
  console.log(`  Intervals:   ${intervals.length} @ 100m`);
  console.log(`  Distance:    ${totalKm.toFixed(1)} km`);
  console.log(`  Elev gain:   ${Math.round(gain)} m`);
  console.log(`  Elev range:  ${Math.min(...eles)}m – ${Math.max(...eles)}m`);
  const json = JSON.stringify(intervals);
  writeFileSync(output, json);
  console.log(`  Output:      ${output}  (${(json.length / 1024).toFixed(0)} KB)`);
}
