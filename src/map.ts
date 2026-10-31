// Offline breadcrumb map: the trail comes only from the clip's own GPS (embedded telemetry, or the single
// location in event.json). No tiles, no network.
import type { Telemetry } from './sei';
import type { OverlayOpts } from './overlay';

export interface Trail { x: number[]; y: number[]; t: number[]; single: boolean; radius: number; }

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
  return { x, y, t, single: new Set(lat.map((v, i) => v.toFixed(5) + lon[i].toFixed(5))).size <= 1, radius: Math.max(30, radius) };
}

function idxAt(tr: Trail, t: number) { let lo = 0, hi = tr.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.t[m] <= t) lo = m; else hi = m - 1; } return lo; }

/** Corner panel inside the HUD rect (0,0,W,H). */
export function drawMapPanel(c: CanvasRenderingContext2D, W: number, H: number, tr: Trail, t: number, heading: number, o: OverlayOpts) {
  const s = Math.max(0.5, Math.min(W / 1280, H / 400)), size = Math.round(190 * s), m = 14 * s;
  const corner = o.mapCorner ?? 'tr';
  const x0 = corner.endsWith('l') ? m : W - size - m, y0 = corner.startsWith('t') ? m + 44 * s : H - size - m - 90 * s;
  c.save();
  c.fillStyle = 'rgba(10,12,16,0.62)'; c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.fill();
  c.beginPath(); c.roundRect(x0, y0, size, size, 12 * s); c.clip();
  const cx = x0 + size / 2, cy = y0 + size / 2, k = (size * 0.42) / tr.radius;
  const i = idxAt(tr, t), headingUp = o.mapNorthUp === false;
  // north-up: fit the whole trail around its centre; heading-up: centre on the car and rotate
  let mx = 0, my = 0;
  if (headingUp) { mx = tr.x[i]; my = tr.y[i]; } else { const xs = tr.x, ys = tr.y; mx = (Math.min(...xs) + Math.max(...xs)) / 2; my = (Math.min(...ys) + Math.max(...ys)) / 2; }
  c.translate(cx, cy); if (headingUp) c.rotate(-heading * Math.PI / 180);
  const P = (j: number): [number, number] => [(tr.x[j] - mx) * k, (tr.y[j] - my) * k];
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = 'rgba(255,255,255,0.28)'; c.lineWidth = 3 * s; c.beginPath();
  tr.x.forEach((_, j) => { const [px, py] = P(j); j ? c.lineTo(px, py) : c.moveTo(px, py); }); c.stroke();
  c.strokeStyle = '#3ea6ff'; c.lineWidth = 3.5 * s; c.beginPath();
  for (let j = 0; j <= i; j++) { const [px, py] = P(j); j ? c.lineTo(px, py) : c.moveTo(px, py); } c.stroke();
  const [px, py] = P(i);
  c.translate(px, py); c.rotate(heading * Math.PI / 180);
  c.fillStyle = '#e31937'; c.strokeStyle = '#fff'; c.lineWidth = 2 * s;
  c.beginPath(); c.moveTo(0, -9 * s); c.lineTo(6.5 * s, 7 * s); c.lineTo(0, 3.5 * s); c.lineTo(-6.5 * s, 7 * s); c.closePath(); c.fill(); c.stroke();
  c.restore(); c.save();
  // north indicator
  const nx = x0 + size - 16 * s, ny = y0 + 16 * s, na = headingUp ? -heading * Math.PI / 180 : 0;
  c.translate(nx, ny); c.rotate(na); c.fillStyle = '#fff'; c.font = `700 ${11 * s}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('N', 0, 0);
  c.restore();
  if (tr.single) { c.fillStyle = '#ccd'; c.font = `${10 * s}px system-ui`; c.textAlign = 'center'; c.fillText(tr.t.length > 1 ? 'Parked (no movement)' : 'Location from event.json', x0 + size / 2, y0 + size - 10 * s); }
}
