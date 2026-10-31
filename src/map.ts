// GPS map panel: the trail comes only from the clip's own GPS (embedded telemetry, or the single location
// in event.json). Optional online map tiles (Esri aerial + street-name labels, or CARTO street map) are
// drawn underneath, zoomed in around the car like a car's top-down navigation view. Tiles are CORS-enabled
// images, so exports stay readable; offline (or style "none") the panel falls back to path + street text.
import type { Telemetry } from './sei';
import type { OverlayOpts } from './overlay';

export interface Trail { x: number[]; y: number[]; t: number[]; single: boolean; radius: number; lat: number[]; lon: number[]; }

/** Builds a local metric trail (metres, x east / y south) for the whole event. */
export function buildTrail(tel: (Telemetry | null)[], segStarts: number[], info?: Record<string, string>): Trail | null {
  const lat: number[] = [], lon: number[] = [], t: number[] = [];
  tel.forEach((T, si) => {
    if (!T?.hasData) return;
    const step = Math.max(1, Math.round(T.n / Math.max(1, T.duration) / 4)); // ~4 points per second
    for (let i = 0; i < T.n; i += step) if (T.lat[i] && T.lon[i]) { lat.push(T.lat[i]); lon.push(T.lon[i]); t.push(segStarts[si] + i / T.n * T.duration); }
  });
  if (!lat.length && info?.est_lat && info?.est_lon) { lat.push(+info.est_lat); lon.push(+info.est_lon); t.push(0); }
  if (!lat.length) return null;
  const lat0 = lat[0], lon0 = lon[0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const x = lon.map(v => (v - lon0) * kx), y = lat.map(v => -(v - lat0) * ky);
  let radius = 0; for (let i = 0; i < x.length; i++) for (const j of [0, x.length - 1]) radius = Math.max(radius, Math.hypot(x[i] - x[j], y[i] - y[j]));
  return { x, y, t, single: new Set(lat.map((v, i) => v.toFixed(5) + lon[i].toFixed(5))).size <= 1, radius: Math.max(30, radius), lat, lon };
}


function idxAt(tr: Trail, t: number) { let lo = 0, hi = tr.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.t[m] <= t) lo = m; else hi = m - 1; } return lo; }

// ---------- tiles ----------
export type MapStyle = 'aerial' | 'streets' | 'dark' | 'none';
export type MapZoom = 'close' | 'medium' | 'fit';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const LAYERS: Record<Exclude<MapStyle, 'none'>, string[]> = {
  aerial: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
  streets: ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
  dark: ['https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png'],
};
const ATTR: Record<string, string> = { aerial: 'Esri, Maxar, Earthstar', streets: '© OpenStreetMap © CARTO', dark: '© OpenStreetMap © CARTO' };
type T = { img: HTMLImageElement | ImageBitmap | null; p: Promise<void> };
const cache = new Map<string, T>();
let onTile: (() => void) | null = null, redrawQueued = false;
/** called (throttled) whenever a tile finishes loading, so the live view can repaint */
export const setTileListener = (f: (() => void) | null) => { onTile = f; };
function tile(url: string): T {
  let e = cache.get(url); if (e) return e;
  const t: T = { img: null, p: Promise.resolve() };
  t.p = (async () => {
    try {
      const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw 0;
      t.img = await createImageBitmap(await r.blob());
      if (onTile && !redrawQueued) { redrawQueued = true; setTimeout(() => { redrawQueued = false; onTile?.(); }, 120); }
    } catch { /* offline: path-only; retry this tile after 30 s */ setTimeout(() => { if (cache.get(url) === t) cache.delete(url); }, 30000); }
  })();
  cache.set(url, t); if (cache.size > 1500) cache.delete(cache.keys().next().value!);
  return t;
}
const TS = 256;
const wx = (lon: number, z: number) => (lon + 180) / 360 * TS * 2 ** z;
const wy = (lat: number, z: number) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TS * 2 ** z; };
function zoomFor(tr: Trail, zoom: MapZoom, view: number): number {
  if (zoom === 'close') return 18; if (zoom === 'medium') return 16;
  const span = Math.max(80, tr.radius * 1.3); // metres to show across the panel
  const mpp = span / view, z = Math.log2(156543 * Math.cos(tr.lat[0] * Math.PI / 180) / mpp);
  return Math.max(11, Math.min(18, Math.floor(z)));
}
const layersOf = (o: OverlayOpts) => (o.mapStyle ?? 'aerial') === 'none' ? [] : LAYERS[(o.mapStyle ?? 'aerial') as Exclude<MapStyle, 'none'>];
const url = (tpl: string, z: number, x: number, y: number) => tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
/** Fetch every tile the panel can show for this trail (used before export so frames are not drawn blank). */
export async function preloadTiles(tr: Trail | null | undefined, o: OverlayOpts, timeoutMs = 15000) {
  if (!tr || !o.map) return; const L = layersOf(o); if (!L.length) return;
  const z = zoomFor(tr, o.mapZoom ?? 'close', 256), need = new Set<string>(), R = 2;
  const st = Math.max(1, Math.floor(tr.lat.length / 400));
  for (let j = 0; j < tr.lat.length; j += st) { const tx = Math.floor(wx(tr.lon[j], z) / TS), ty = Math.floor(wy(tr.lat[j], z) / TS);
    for (let dx = -R + 1; dx < R; dx++) for (let dy = -R + 1; dy < R; dy++) for (const l of L) need.add(url(l, z, tx + dx, ty + dy)); }
  const all = [...need].slice(0, 600).map(u => tile(u).p);
  await Promise.race([Promise.all(all), new Promise(r => setTimeout(r, timeoutMs))]);
}

/** Corner panel inside the HUD rect (0,0,W,H). */
export function drawMapPanel(c: CanvasRenderingContext2D, W: number, H: number, tr: Trail, t: number, heading: number, o: OverlayOpts, label = '') {
  const s = Math.max(0.5, Math.min(W / 1280, H / 400)), size = Math.round(230 * s), m = 14 * s;
  const corner = o.mapCorner ?? 'tr';
  const x0 = corner.endsWith('l') ? m : W - size - m, y0 = corner.startsWith('t') ? m + 44 * s : H - size - m - 90 * s;
  const i = idxAt(tr, t), headingUp = o.mapNorthUp === false, zm = o.mapZoom ?? 'close';
  const z = zoomFor(tr, zm, 256), L = layersOf(o);
  // pixel scale so 'close' shows ~150-250 m across regardless of output size
  const q = size / 256;
  const PX = tr.lon.map(v => wx(v, z)), PY = tr.lat.map(v => wy(v, z));
  let mx: number, my: number;
  if (zm === 'fit' && !headingUp) { mx = (Math.min(...PX) + Math.max(...PX)) / 2; my = (Math.min(...PY) + Math.max(...PY)) / 2; } else { mx = PX[i]; my = PY[i]; }
  c.save();
  c.fillStyle = 'rgba(10,12,16,0.62)'; c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.fill();
  c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.clip();
  const cx = x0 + size / 2, cy = y0 + size / 2;
  c.translate(cx, cy); if (headingUp) c.rotate(-heading * Math.PI / 180);
  c.scale(q, q);
  // tiles: cover a circle of the panel diagonal (works for rotated heading-up too)
  let tiles = 0, loaded = 0;
  if (L.length) {
    const rad = size / q * 0.75, tx0 = Math.floor((mx - rad) / TS), tx1 = Math.floor((mx + rad) / TS), ty0 = Math.floor((my - rad) / TS), ty1 = Math.floor((my + rad) / TS);
    for (const l of L) for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const T = tile(url(l, z, tx, ty)); tiles++;
      if (T.img) { loaded++; c.drawImage(T.img, tx * TS - mx, ty * TS - my, TS + 0.5, TS + 0.5); }
    }
  }
  const P = (j: number): [number, number] => [PX[j] - mx, PY[j] - my];
  const lw = 1 / q;
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 7 * s * lw; c.beginPath();
  tr.x.forEach((_, j) => { const [px, py] = P(j); j ? c.lineTo(px, py) : c.moveTo(px, py); }); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 3.5 * s * lw; c.beginPath();
  tr.x.forEach((_, j) => { const [px, py] = P(j); j ? c.lineTo(px, py) : c.moveTo(px, py); }); c.stroke();
  c.strokeStyle = '#3ea6ff'; c.lineWidth = 4.5 * s * lw; c.beginPath();
  for (let j = 0; j <= i; j++) { const [px, py] = P(j); j ? c.lineTo(px, py) : c.moveTo(px, py); } c.stroke();
  const [px, py] = P(i);
  c.translate(px, py); c.rotate(heading * Math.PI / 180); c.scale(lw * s, lw * s);
  c.fillStyle = '#e31937'; c.strokeStyle = '#fff'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, -11); c.lineTo(8, 8.5); c.lineTo(0, 4); c.lineTo(-8, 8.5); c.closePath(); c.fill(); c.stroke();
  c.restore(); c.save();
  c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.clip();
  // north indicator
  const nx = x0 + size - 16 * s, ny = y0 + 16 * s, na = headingUp ? -heading * Math.PI / 180 : 0;
  c.fillStyle = 'rgba(0,0,0,0.5)'; c.beginPath(); c.arc(nx, ny, 10 * s, 0, 7); c.fill();
  c.translate(nx, ny); c.rotate(na); c.fillStyle = '#fff'; c.font = `700 ${11 * s}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('N', 0, 0);
  c.setTransform(c.getTransform()); c.restore(); c.save();
  c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.clip();
  // street / place label + attribution
  const street = (label || '').split(',')[0].trim();
  const note = tr.single ? (tr.t.length > 1 ? 'Parked (no movement)' : 'Location from event.json') : '';
  const text = street || note;
  if (text) {
    c.font = `600 ${12 * s}px system-ui`; const tw = Math.min(size - 16 * s, c.measureText(text).width);
    c.fillStyle = 'rgba(0,0,0,0.62)'; c.beginPath(); c.roundRect(x0 + (size - tw) / 2 - 8 * s, y0 + size - 34 * s, tw + 16 * s, 20 * s, 6 * s); c.fill();
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, x0 + size / 2, y0 + size - 24 * s, size - 16 * s);
  }
  if (L.length && loaded) { c.font = `${8 * s}px system-ui`; c.fillStyle = 'rgba(255,255,255,0.75)'; c.textAlign = 'right'; c.textBaseline = 'bottom'; c.fillText(ATTR[o.mapStyle ?? 'aerial'], x0 + size - 6 * s, y0 + size - 2 * s); }
  c.restore();
  return { tiles, loaded };
}
