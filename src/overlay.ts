import type { Telemetry } from './sei';

export interface OverlayOpts {
  speed: boolean; gear: boolean; autopilot: boolean; steering: boolean; pedals: boolean;
  gforce: boolean; blinkers: boolean; location: boolean; clock: boolean; compass: boolean;
  units: 'mph' | 'kmh';
  /** Sentry-only elements (optional; default on). */
  sentryBadge?: boolean; sentryTrigger?: boolean;
  /** offline breadcrumb map (off by default) */
  map?: boolean; mapCorner?: 'tl' | 'tr' | 'bl' | 'br'; mapNorthUp?: boolean;
}
export const defaultOverlay: OverlayOpts = {
  speed: true, gear: true, autopilot: true, steering: true, pedals: true,
  gforce: true, blinkers: true, location: true, clock: true, compass: true, units: 'mph',
  map: false, mapCorner: 'tr', mapNorthUp: true,
};

export interface HudFrame { t: Telemetry | null; i: number; time: Date; place: string; }

const AP_NAME = ['', 'FSD', 'Autosteer', 'TACC'];
const GEAR = ['P', 'D', 'R', 'N'];
const G = 9.80665;

/**
 * Tesla's linear_acceleration axes (verified against speed changes in real clips):
 * y is longitudinal with accelerating = negative, x is lateral (+ when turning right).
 * Returns smoothed [longitudinal (+accel), lateral (+right)] in m/s².
 */
export function accel(t: Telemetry, i: number, win = 5): [number, number] {
  let lo = 0, la = 0, n = 0;
  for (let k = Math.max(0, i - win); k <= Math.min(t.n - 1, i + win); k++) { lo -= t.ay[k]; la += t.ax[k]; n++; }
  return n ? [lo / n, la / n] : [0, 0];
}

function panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.fillStyle = 'rgba(10,12,16,0.62)';
  c.beginPath(); c.roundRect(x, y, w, h, r); c.fill();
}


/** Draws the HUD into the rectangle (0,0,W,H) of ctx. Shared by preview and export. */
export function drawHud(c: CanvasRenderingContext2D, W: number, H: number, f: HudFrame, o: OverlayOpts) {
  const s = Math.max(0.5, Math.min(W / 1280, H / 400));
  const t = f.t, i = Math.min(f.i, t ? t.n - 1 : 0);
  const has = !!t && t.hasData && i >= 0;
  c.save();
  c.textBaseline = 'middle';
  const font = (px: number, wgt = 600) => `${wgt} ${Math.round(px * s)}px system-ui, Segoe UI, sans-serif`;
  const pad = 16 * s;

  // ---- main cluster (bottom-left) ----
  const cw = 300 * s, ch = 150 * s, cx = pad, cy = H - ch - pad;
  if (has && (o.speed || o.gear || o.autopilot || o.pedals || o.steering || o.blinkers)) {
    panel(c, cx, cy, cw, ch, 18 * s);
    const sp = t!.speed[i] * (o.units === 'mph' ? 2.23694 : 3.6);
    if (o.speed) {
      c.fillStyle = '#fff'; c.font = font(64, 700); c.textAlign = 'left';
      c.fillText(Math.round(Math.abs(sp)).toString(), cx + 20 * s, cy + 58 * s);
      c.font = font(18, 500); c.fillStyle = '#bbb';
      c.fillText(o.units === 'mph' ? 'MPH' : 'KM/H', cx + 22 * s, cy + 100 * s);
    }
    if (o.gear) {
      c.font = font(20, 700); c.textAlign = 'left';
      GEAR.forEach((g, k) => {
        c.fillStyle = t!.gear[i] === k ? '#fff' : 'rgba(255,255,255,0.3)';
        c.fillText(g, cx + 20 * s + k * 22 * s, cy + 130 * s);
      });
    }
    if (o.autopilot) {
      const ap = t!.ap[i];
      if (ap) {
        c.fillStyle = ap === 1 ? '#3e8bff' : ap === 2 ? '#3ec1ff' : '#9aa';
        c.beginPath(); c.roundRect(cx + 120 * s, cy + 14 * s, 110 * s, 28 * s, 14 * s); c.fill();
        c.fillStyle = '#fff'; c.font = font(15, 700); c.textAlign = 'center';
        c.fillText(AP_NAME[ap] ?? 'AP', cx + 175 * s, cy + 28 * s);
      }
    }
    if (o.steering) {
      const r = 30 * s, wx = cx + 160 * s, wy = cy + 90 * s, a = t!.steer[i] * Math.PI / 180;
      c.save(); c.translate(wx, wy); c.rotate(a);
      c.strokeStyle = t!.ap[i] === 1 || t!.ap[i] === 2 ? '#3ec1ff' : '#fff'; c.lineWidth = 5 * s;
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(-r, 0); c.lineTo(r, 0); c.moveTo(0, 0); c.lineTo(0, r); c.stroke();
      c.restore();
      c.fillStyle = '#ccc'; c.font = font(12, 500); c.textAlign = 'center';
      c.fillText(`${Math.round(t!.steer[i])}°`, wx, wy + r + 14 * s);
    }
    if (o.pedals) {
      // Driver pedal % / brake switch come straight from telemetry. Under FSD/Autopilot the
      // driver isn't touching the pedals (both read 0), so we show the car's own
      // acceleration / deceleration (from the accelerometer) in blue instead.
      const bx = cx + 220 * s, by = cy + 50 * s, bh = 85 * s, bw = 16 * s;
      const [lo] = accel(t!, i, 8);
      const pedal = Math.max(0, Math.min(100, t!.pedal[i])) / 100, brake = !!(t!.flags[i] & 4);
      const auto = !!t!.ap[i] && pedal === 0 && !brake;
      const accP = pedal > 0 ? pedal : auto ? Math.max(0, Math.min(1, lo / 2.5)) : 0;
      const brkP = brake ? 1 : Math.max(0, Math.min(1, -lo / 3.5));
      c.fillStyle = 'rgba(255,255,255,0.15)'; c.fillRect(bx, by, bw, bh); c.fillRect(bx + 24 * s, by, bw, bh);
      c.fillStyle = pedal > 0 ? '#3ddc84' : '#3e8bff'; c.fillRect(bx, by + bh * (1 - accP), bw, bh * accP);
      c.fillStyle = brake ? '#ff3b30' : auto ? '#3e8bff' : '#ff9f0a'; c.fillRect(bx + 24 * s, by + bh * (1 - brkP), bw, bh * brkP);
      c.fillStyle = '#ccc'; c.font = font(10, 600); c.textAlign = 'center';
      c.fillText('ACC', bx + bw / 2, by - 9 * s); c.fillText('BRK', bx + 24 * s + bw / 2, by - 9 * s);
      c.font = font(9, 600); c.fillStyle = '#fff';
      c.fillText(pedal > 0 ? `${Math.round(pedal * 100)}%` : '', bx + bw / 2, by + bh + 8 * s);
      if (auto) { c.fillStyle = '#3e8bff'; c.fillText('AUTO', bx + 20 * s, by + bh + 8 * s); }
    }
    if (o.blinkers) {
      const fl = t!.flags[i], on = Math.floor(f.time.getTime() / 400) % 2 === 0;
      const arrow = (x: number, dir: number, lit: boolean) => {
        c.fillStyle = lit && on ? '#3ddc84' : 'rgba(255,255,255,0.12)';
        c.beginPath(); const y = cy + 28 * s;
        c.moveTo(x, y); c.lineTo(x + dir * 14 * s, y - 10 * s); c.lineTo(x + dir * 14 * s, y + 10 * s); c.fill();
      };
      arrow(cx + 245 * s, -1, !!(fl & 1)); arrow(cx + 262 * s, 1, !!(fl & 2));
    }
  }

  // ---- g-force (bottom-right) ----
  if (has && o.gforce) {
    const r = 58 * s, gx = W - pad - r - 12 * s, gy = H - pad - r - 12 * s;
    panel(c, gx - r - 12 * s, gy - r - 12 * s, 2 * r + 24 * s, 2 * r + 24 * s, 18 * s);
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 1.5 * s;
    for (const k of [1, 0.5]) { c.beginPath(); c.arc(gx, gy, r * k, 0, Math.PI * 2); c.stroke(); }
    c.beginPath(); c.moveTo(gx - r, gy); c.lineTo(gx + r, gy); c.moveTo(gx, gy - r); c.lineTo(gx, gy + r); c.stroke();
    // "felt force" convention: accelerating pushes the dot DOWN, braking UP,
    // a right turn pushes it LEFT. Full scale = 0.6 g.
    const [la, lt] = accel(t!, i), lon = la / G, lat = lt / G, scale = r / 0.6, cl = (v: number) => Math.max(-0.6, Math.min(0.6, v));
    const px = gx - cl(lat) * scale, py = gy + cl(lon) * scale;
    c.fillStyle = '#9ab'; c.font = font(10, 600); c.textAlign = 'center';
    c.fillText('BRAKE', gx, gy - r - 2 * s + 8 * s); c.fillText('ACCEL', gx, gy + r - 8 * s);
    c.fillStyle = '#ffcc00'; c.beginPath(); c.arc(px, py, 7 * s, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.font = font(13, 600); c.textAlign = 'center';
    c.fillText(`${Math.hypot(lon, lat).toFixed(2)} g`, gx + r * 0.62, gy - r * 0.78);
  }

  // ---- top bar: clock / location / compass ----
  const top: string[] = [];
  if (o.clock) top.push(f.time.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }));
  if (o.location && f.place) top.push(f.place);
  if (has && o.compass && (t!.lat[i] || t!.lon[i])) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], hd = ((t!.heading[i] % 360) + 360) % 360;
    top.push(`${dirs[Math.round(hd / 45) % 8]} ${Math.round(hd)}°`);
  }
  if (top.length) {
    c.font = font(17, 600);
    const txt = top.join('   ·   ');
    const w = c.measureText(txt).width + 32 * s;
    panel(c, pad, pad, w, 38 * s, 12 * s);
    c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(txt, pad + 16 * s, pad + 19 * s);
  }
  c.restore();
}

export type Mode = 'driving' | 'sentry';
// event.json "camera" index -> name (community-documented mapping)
export const TRIGGER_CAM: Record<string, string> = { '0': 'Front', '1': 'Front', '2': 'Front', '3': 'Left pillar', '4': 'Right pillar', '5': 'Left repeater', '6': 'Right repeater', '7': 'Rear' };

export interface SentryInfo { reason?: string; camera?: string; trigger?: Date; place: string; }

/** Sentry overlay: badge, date/time, trigger reason & camera, time relative to the trigger. */
export function drawSentryHud(c: CanvasRenderingContext2D, W: number, H: number, time: Date, info: SentryInfo, o: OverlayOpts) {
  const s = Math.max(0.5, Math.min(W / 1280, H / 400)), pad = 16 * s;
  const font = (px: number, w = 600) => `${w} ${Math.round(px * s)}px system-ui, Segoe UI, sans-serif`;
  c.save(); c.textBaseline = 'middle'; c.textAlign = 'left';
  // badge
  if (o.sentryBadge !== false) {
  const blink = Math.floor(time.getTime() / 500) % 2 === 0;
  panel(c, pad, pad, 190 * s, 40 * s, 20 * s);
  c.fillStyle = blink ? '#ff3b30' : '#7a1d18'; c.beginPath(); c.arc(pad + 22 * s, pad + 20 * s, 8 * s, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.font = font(18, 700); c.fillText('SENTRY MODE', pad + 40 * s, pad + 20 * s);
  }
  // clock
  if (o.clock) {
    const txt = time.toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
    c.font = font(18, 600); const w = c.measureText(txt).width + 32 * s;
    panel(c, W - pad - w, pad, w, 40 * s, 12 * s); c.fillStyle = '#fff'; c.fillText(txt, W - pad - w + 16 * s, pad + 20 * s);
  }
  // bottom info
  const lines: string[] = [];
  const trig = o.sentryTrigger !== false;
  if (trig && info.reason) lines.push('Trigger: ' + info.reason.replace(/^sentry_/, '').replace(/_/g, ' '));
  if (trig && info.camera !== undefined) lines.push('Camera: ' + (TRIGGER_CAM[info.camera] ?? '#' + info.camera));
  if (trig && info.trigger) {
    const d = (time.getTime() - info.trigger.getTime()) / 1000;
    lines.push(Math.abs(d) < 1 ? '● TRIGGER' : `${d < 0 ? 'T−' : 'T+'}${Math.abs(d).toFixed(0)}s`);
  }
  if (o.location && info.place) lines.push(info.place);
  if (lines.length) {
    c.font = font(16, 600); const txt = lines.join('   ·   ');
    const w = c.measureText(txt).width + 32 * s;
    panel(c, pad, H - pad - 38 * s, w, 38 * s, 12 * s); c.fillStyle = '#fff'; c.fillText(txt, pad + 16 * s, H - pad - 19 * s);
  }
  c.restore();
}
