import { renderPano3, p3Regions, p3Aspect } from './pano3';
import { defish, defishOn } from './defish';
import { camLabel, CAMERAS, type Camera } from './library';

export type Layout = 'theater' | 'single' | 'grid' | 'pip' | 'stitch' | 'pano' | 'panorear' | 'pano3';
/** mirror the rear camera in stitched layouts (rear-view-mirror orientation lines its left edge up with the left repeater) */
export const rearMirror = () => { try { return localStorage.getItem('tcc.rearMirror') !== '0'; } catch { return true; } };
type Src = CanvasImageSource & ({ videoWidth: number; videoHeight: number } | { displayWidth: number; displayHeight: number });
export type Rect = [number, number, number, number];
/** per-camera stabilisation transform: shift (fraction of the drawn image) and zoom */
export type Xf = [number, number, number, ...number[]]; // optional warp: kl, kr, rot(deg), p

function dims(s: Src): [number, number] {
  return 'videoWidth' in s ? [s.videoWidth, s.videoHeight] : [s.displayWidth, s.displayHeight];
}
/** draw s into rect; cover=true fills the rect (centre crop), else letterboxes */
function fit(c: CanvasRenderingContext2D, s: Src | undefined, [x, y, w, h]: Rect, label?: string, cover = false, xf?: Xf, cam?: string, mirror = false, border = true) {
  c.fillStyle = '#000'; c.fillRect(x, y, w, h);
  if (s) {
    const [sw, sh] = dims(s);
    if (sw && sh) {
      const k = cover ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh), bw = sw * k, bh = sh * k;
      const z = xf?.[2] ?? 1, dw = bw * z, dh = bh * z;
      const ox = (xf?.[0] ?? 0) * dw, oy = (xf?.[1] ?? 0) * dh;
      c.save(); c.beginPath(); c.rect(x + (w - Math.min(w, bw)) / 2, y + (h - Math.min(h, bh)) / 2, Math.min(w, bw), Math.min(h, bh)); c.clip();
      const img = cam && defishOn(cam) ? defish(s as TexImageSource, sw, sh, cam) ?? s : s;
      if (mirror) { c.translate(2 * x + w, 0); c.scale(-1, 1); }
      const X0 = x + (w - dw) / 2 + ox, Y0 = y + (h - dh) / 2 + oy;
      if (xf && xf.length > 3 && (xf[3] !== 1 || xf[4] !== 1 || xf[5] || xf[6])) warpDraw(c, img as CanvasImageSource, sw, sh, X0, Y0, dw, dh, x + w / 2, y + h / 2, xf[3], xf[4], xf[5], xf[6], mirror);
      else c.drawImage(img, X0, Y0, dw, dh);
      c.restore();
    }
  }
  else if (label) { c.fillStyle = '#666'; c.font = `500 ${Math.max(11, Math.round(Math.min(h / 14, 16)))}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('No video', x + w / 2, y + h / 2); }
  if (label) {
    const fs = Math.max(11, Math.round(Math.min(h / 12, 18)));
    c.font = `600 ${fs}px system-ui, sans-serif`;
    const tw = c.measureText(label).width;
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x + w - tw - 18, y + 6, tw + 12, fs + 8);
    c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(label, x + w - tw - 12, y + 10 + fs / 2);
  }
  if (border) { c.strokeStyle = '#000'; c.lineWidth = 2; c.strokeRect(x, y, w, h); }
}

/** Output aspect (H/W) per layout. Theater is taller so every camera gets a usable size. */
export const layoutAspect = (l: Layout) => l === 'pano3' ? p3Aspect(3) : l === 'pano' ? p3Aspect(5) : l === 'theater' || l === 'stitch' ? 0.9 : l === 'panorear' ? 0.6 : 9 / 16;

/** f = feather widths [left, right, top, bottom] in px: the cell overlaps its neighbour there and fades in */
export interface Plan { cells: { cam: Camera; r: Rect; cover: boolean; f?: [number, number, number, number]; mirror?: boolean }[]; hud: Rect; }

/** Front panorama order, left to right; neighbours overlap and are cross-faded. */
const PANO: Camera[] = ['left_repeater', 'left_pillar', 'front', 'right_pillar', 'right_repeater'];
const PANO_W: Record<string, number> = { left_repeater: 0.75, left_pillar: 0.85, front: 1.4, right_pillar: 0.85, right_repeater: 0.75 };
function panoCells(cells: Plan['cells'], W: number, y: number, h: number, cams: Camera[]) {
  const row = PANO.filter(c => cams.includes(c));
  if (!row.length) return;
  const tot = row.reduce((a, c) => a + PANO_W[c], 0), ov = 0.14; // overlap = 14% of the narrower neighbour
  const raw = row.map(c => PANO_W[c]);
  const seams = raw.slice(1).map((v, i) => Math.min(v, raw[i]) * ov);
  const k = W / (tot - seams.reduce((a, b) => a + b, 0));
  let x = 0;
  row.forEach((c, i) => {
    const w = raw[i] * k, fl = i ? seams[i - 1] * k : 0, fr = i < row.length - 1 ? seams[i] * k : 0;
    cells.push({ cam: c, r: [x, y, w, h], cover: true, f: [fl, 0, 0, 0] });
    x += w - fr;
  });
}

/**
 * Theater ("All cameras"): front full width on top; side cameras in two columns below
 * (left pillar over left repeater | right pillar over right repeater), front bumper cam in a
 * centre column when present; rear full width at the bottom, same width as the front.
 */
export function plan(W: number, H: number, layout: Layout, main: Camera, cams: Camera[]): Plan {
  const has = (c: Camera) => cams.includes(c);
  const cells: Plan['cells'] = [];
  if (layout === 'single' || cams.length <= 1) {
    const c = has(main) ? main : cams[0];
    cells.push({ cam: c, r: [0, 0, W, H], cover: false });
    return { cells, hud: [0, 0, W, H] };
  }
  if (layout === 'pip') {
    const m = has(main) ? main : cams[0];
    cells.push({ cam: m, r: [0, 0, W, H], cover: false });
    const others = cams.filter(c => c !== m), w = W * 0.2, h = H * 0.2;
    others.slice(0, 4).forEach((c, n) => cells.push({ cam: c, r: [W - w - 10, 70 + n * (h + 6), w, h], cover: true }));
    return { cells, hud: [0, 0, W, H] };
  }
  if (layout === 'grid') {
    const order = [has(main) ? main : cams[0], ...cams.filter(c => c !== main)];
    const n = order.length, cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), w = W / cols, h = H / rows;
    order.forEach((c, k) => cells.push({ cam: c, r: [(k % cols) * w, Math.floor(k / cols) * h, w, h], cover: false }));
    return { cells, hud: [0, 0, W, H] };
  }
  if (layout === 'pano3' || layout === 'pano') {
    for (const g of p3Regions(W, H, c => has(c), layout === 'pano' ? 5 : 3)) cells.push({ cam: g.cam, r: g.r, cover: false });
    if (!cells.length) cells.push({ cam: cams[0], r: [0, 0, W, H], cover: false });
    return { cells, hud: [0, 0, W, H] };
  }
  if (layout === 'panorear') {
    const rear = layout === 'panorear' && has('back');
    const pH = rear ? H / 2 : H;
    if (PANO.some(has)) panoCells(cells, W, 0, pH + (rear ? pH * 0.06 : 0), cams);
    else cells.push({ cam: cams[0], r: [0, 0, W, pH], cover: true });
    if (rear) cells.push({ cam: 'back', r: [0, pH - pH * 0.06, W, H - pH + pH * 0.06], cover: true, f: [0, 0, pH * 0.12, 0], mirror: rearMirror() });
    return { cells, hud: [0, 0, W, rear ? pH : H] };
  }
  // theater / stitch
  const left = ['left_pillar', 'left_repeater'].filter(has), right = ['right_pillar', 'right_repeater'].filter(has);
  const extra = cams.filter(c => !['front', 'back', ...left, ...right].includes(c)); // e.g. front_wide
  const front = has('front') ? 'front' : cams[0];
  const rear = has('back') ? 'back' : undefined;
  const sideRows = Math.max(left.length, right.length, extra.length ? 1 : 0);
  const fH = H * (rear ? 0.32 : 0.45), rH = rear ? H * 0.32 : 0;
  const midH = H - fH - rH;
  const st = layout === 'stitch', ov = st ? H * 0.035 : 0; // stitched: rows overlap and cross-fade
  cells.push({ cam: front, r: [0, 0, W, fH + ov], cover: true });
  const ex = extra.filter(c => c !== front);
  const cols: Camera[][] = [left, ...(ex.length ? [ex] : []), right].filter(c => c.length);
  const cw = W / Math.max(1, cols.length);
  cols.forEach((col, ci) => {
    const rh = midH / (col === ex ? ex.length : sideRows || 1);
    col.forEach((c, ri) => {
      if (!st) return cells.push({ cam: c, r: [ci * cw, fH + ri * rh, cw, rh], cover: true });
      const cov = cw * 0.06, x0 = ci * cw - (ci ? cov : 0), w = cw + (ci ? cov : 0) + (ci < cols.length - 1 ? cov : 0);
      cells.push({ cam: c, r: [x0, fH - ov + ri * rh, w, rh + 2 * ov], cover: true, f: [ci ? cov * 2 : 0, 0, ov * 2, 0] });
    });
  });
  if (rear) cells.push(st ? { cam: rear, r: [0, H - rH - ov, W, rH + ov], cover: true, f: [0, 0, ov * 2, 0], mirror: rearMirror() } : { cam: rear, r: [0, H - rH, W, rH], cover: true });
  return { cells, hud: [0, 0, W, fH] };
}

/**
 * Perspective (keystone) warp drawn as thin vertical slices: column u in [0,1] lands at the projective position
 * u' = u(1+p)/(1+p u) (p>0 compresses the right side, p<0 the left) and is scaled vertically by kl..kr about the
 * horizon line, so the outer edge of a side camera can be made taller than its inner edge, like a homography
 * that maps the rectangle to a trapezoid with vertical sides. rot tilts the whole camera about the cell centre.
 * kl/kr are in screen orientation (after a mirror flip).
 */
function warpDraw(c: CanvasRenderingContext2D, img: CanvasImageSource, sw: number, sh: number, X0: number, Y0: number, dw: number, dh: number, cx: number, cy: number, kl = 1, kr = 1, rot = 0, p = 0, mirror = false) {
  if (rot) { c.translate(cx, cy); c.rotate((mirror ? -rot : rot) * Math.PI / 180); c.translate(-cx, -cy); }
  if (mirror) { const t = kl; kl = kr; kr = t; p = -p; }
  const N = Math.max(16, Math.min(96, Math.round(dw / 12)));
  const P = (u: number) => p >= 0 ? u * (1 + p) / (1 + p * u) : 1 - (1 - u) * (1 - p) / (1 - p * (1 - u));
  const hy = Y0 + dh / 2;
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N, a = P(u0), b = P(u1), k = kl + (kr - kl) * (a + b) / 2;
    const sx = u0 * sw, sww = sw / N, ddx = X0 + a * dw, ddw = (b - a) * dw + 0.6, ddh = dh * k;
    c.drawImage(img, sx, 0, sww, sh, ddx, hy - ddh / 2, ddw, ddh);
  }
}

export function compose(c: CanvasRenderingContext2D, W: number, H: number, layout: Layout, main: Camera, src: Record<Camera, Src | undefined>, xf: Record<Camera, Xf> = {}, all: Camera[] = []): Rect {
  // Lay out every camera the event has (not only the ones with a frame right now), so a camera that is
  // missing from one clip or failed to decode keeps its slot (shown as 'No video') instead of vanishing.
  const have = new Set([...all, ...Object.keys(src).filter(k => src[k])]);
  const cams = [...CAMERAS, ...[...have].filter(k => !CAMERAS.includes(k))].filter(k => have.has(k));
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const p = plan(W, H, layout, main, cams);
  if ((layout === 'pano3' || layout === 'pano') && cams.some(k => k === 'front' || k.includes('pillar') || (layout === 'pano' && k.includes('repeater')))) {
    if (typeof window !== "undefined" && W > 0) (window as any).__lastPlan = { W, H, cells: p.cells.map(c => ({ cam: c.cam, r: c.r })) };
    const cv = renderPano3(src as any, Math.round(W), Math.round(H), layout === 'pano' ? 5 : 3);
    if (cv) { c.drawImage(cv as CanvasImageSource, 0, 0, W, H); for (const cell of p.cells) tag(c, cell.r, camLabel(cell.cam)); return p.hud; }
    return compose(c, W, H, 'grid', main, src, xf, all); // no WebGL: plain grid
  }
  if (typeof window !== "undefined" && W > 0) (window as any).__lastPlan = { W, H, cells: p.cells.map(c => ({ cam: c.cam, r: c.r })) };
  const showLabels = p.cells.length > 1;
  const stitched = p.cells.some(x => x.f);
  if (stitched) p.cells.forEach(cell => { const sp = stitchPref(cell.cam, stitchGroup(layout)); if (cell.f) cell.f = cell.f.map(v => v * sp.b) as any; });
  p.cells.forEach((cell, i) => {
    const lab = showLabels && !stitched ? camLabel(cell.cam) : undefined;
    const x = stitched ? withStitch(xf[cell.cam], cell.cam, stitchGroup(layout)) : xf[cell.cam];
    if (!cell.f) return fit(c, src[cell.cam], cell.r, lab, cell.cover, x, cell.cam, cell.mirror, !stitched);
    feathered(c, i, src[cell.cam], cell.r, cell.f, x, cell.cam, !!cell.mirror);
  });
  if (layout === 'panorear') trapezoid(c, p.cells, W);
  if (stitched && showLabels) for (const cell of p.cells) tag(c, cell.r, camLabel(cell.cam) + (cell.mirror ? ' (mirrored)' : ''), cell.f);
  return p.hud;
}

/** Panorama envelope (like the hand-made mockups): the front is the shortest tile and the side tiles grow
 *  linearly to full height at the outer edges, so every side camera is shown as a visible trapezoid. */
export const PANO_ENVELOPE = 0.72;
function trapezoid(c: CanvasRenderingContext2D, cells: Plan['cells'], W: number) {
  const fr = cells.find(x => x.cam === 'front' && PANO.includes(x.cam)), row = cells.filter(x => PANO.includes(x.cam));
  if (!row.length) return;
  const [, y, , h] = (fr ?? row[0]).r, cx0 = fr ? fr.r[0] : W / 2, cx1 = fr ? fr.r[0] + fr.r[2] : W / 2;
  const m = h * (1 - PANO_ENVELOPE) / 2;
  c.save(); c.fillStyle = '#000';
  c.beginPath(); c.moveTo(0, y - 1); c.lineTo(W, y - 1); c.lineTo(W, y); c.lineTo(cx1, y + m); c.lineTo(cx0, y + m); c.lineTo(0, y); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(0, y + h + 1); c.lineTo(W, y + h + 1); c.lineTo(W, y + h); c.lineTo(cx1, y + h - m); c.lineTo(cx0, y + h - m); c.lineTo(0, y + h); c.closePath(); c.fill();
  c.restore();
}

const pool: (HTMLCanvasElement | OffscreenCanvas)[] = [];
function scratch(i: number, w: number, h: number) {
  let cv = pool[i];
  if (!cv) cv = pool[i] = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}
/** Draw a camera into an offscreen buffer, fade its overlapping edges to transparent, then blend it over what is already drawn. */
function feathered(c: CanvasRenderingContext2D, i: number, s: Src | undefined, [x, y, w, h]: Rect, [fl, fr, ft, fb]: [number, number, number, number], xf: Xf | undefined, cam: string, mirror: boolean) {
  if (!s) return; // missing camera: leave whatever the neighbours / background show
  const bw = Math.max(1, Math.round(w)), bh = Math.max(1, Math.round(h));
  const cv = scratch(i, bw, bh), g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, bw, bh);
  fit(g, s, [0, 0, bw, bh], undefined, true, xf, cam, mirror, false);
  g.globalCompositeOperation = 'destination-in';
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, 0, bw, bh);
  };
  if (fl > 0) edge(0, 0, fl, 0);
  if (fr > 0) edge(bw, 0, bw - fr, 0);
  if (ft > 0) edge(0, 0, 0, ft);
  if (fb > 0) edge(0, bh, 0, bh - fb);
  g.globalCompositeOperation = 'source-over';
  c.drawImage(cv as CanvasImageSource, x, y, w, h);
}
function tag(c: CanvasRenderingContext2D, [x, y, w, h]: Rect, label: string, f?: number[]) {
  const fs = Math.max(10, Math.round(Math.min(h / 14, 15)));
  c.font = `600 ${fs}px system-ui, sans-serif`;
  const tw = c.measureText(label).width, tx = x + (f?.[0] ?? 0) + 8, ty = y + (f?.[2] ?? 0) + 6;
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(tx, ty, tw + 10, fs + 6);
  c.fillStyle = 'rgba(255,255,255,0.85)'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(label, tx + 5, ty + 3 + fs / 2);
}

// ---- stitch alignment prefs: per camera shift (fraction of drawn image), zoom, blend-width multiplier ----
export interface StitchPref { dx: number; dy: number; z: number; b: number; kl: number; kr: number; rot: number; p: number; }
/** defaults tuned on real HW4 footage (I-85 daytime, 2026-05-06) */
const D = (dy = 0, z = 1.15, dx = 0, kl = 1, kr = 1, rot = 0, p = 0): StitchPref => ({ dx, dy, z, b: 1, kl, kr, rot, p });
/** Defaults per layout family ('p' = panoramas, 's' = stitched all cameras), tuned with the edge-profile
 *  auto-align on real HW4 footage (I-85 daytime, 2026-05-06, medians over 5 frames). */
export const STITCH_DEFAULTS: Record<string, Record<string, StitchPref>> = {
  // D(dy, zoom, dx, leftEdgeHeight, rightEdgeHeight, tiltDeg, perspective): outer edges taller than inner ones (keystone) + slight tilt
  p: { front: D(), left_pillar: D(0.05, 1.25, 0, 1.3, 0.85, -4), left_repeater: D(0.18, 1.25, 0, 1.7, 1.3, -3), right_pillar: D(0.03, 1.25, 0, 0.85, 1.3, 3), right_repeater: D(0.055, 1.25, 0, 1.3, 1.7, 3), back: D(0.06, 1.25, 0.04) },
  s: { front: D(), left_pillar: D(0, 1.15), left_repeater: D(0, 1.15), right_pillar: D(0, 1.15), right_repeater: D(0, 1.15), back: D(0.08, 1.25, 0.04) },
};
// panoramas: narrow seams (30% of the overlap is cross-faded, the rest is a hard cut)
for (const v of Object.values(STITCH_DEFAULTS.p)) v.b = 0.3;
export const stitchGroup = (l: Layout) => l === 'stitch' ? 's' : 'p';
const SKEY = 'tcc.stitch4';
let sCache: Record<string, Partial<StitchPref>> | null = null;
function sLoad() { if (!sCache) { try { sCache = JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch { sCache = {}; } } return sCache!; }
export function stitchPref(cam: string, g = 'p'): StitchPref { return { ...(STITCH_DEFAULTS[g]?.[cam] ?? D()), ...(sLoad()[g + ':' + cam] ?? {}) } as StitchPref; }
export function setStitchPref(cam: string, v: Partial<StitchPref> | null, g = 'p') {
  const k = g + ':' + cam, all = sLoad(); if (v) all[k] = { ...all[k], ...v }; else delete all[k];
  try { localStorage.setItem(SKEY, JSON.stringify(all)); } catch { /* private mode */ }
}
export const resetStitch = () => { sCache = {}; try { localStorage.removeItem(SKEY); } catch { /* */ } };
function withStitch(x: Xf | undefined, cam: string, g: string): Xf {
  const p = stitchPref(cam, g);
  return [(x?.[0] ?? 0) + p.dx, (x?.[1] ?? 0) + p.dy, (x?.[2] ?? 1) * p.z, p.kl, p.kr, p.rot, p.p];
}

/**
 * One-shot auto-align: for every blended camera (front stays fixed), search the shift that best matches its
 * overlap band against what is already drawn there, comparing edge (gradient) maps so exposure differences
 * between cameras don't matter. Runs on a small canvas; the result is saved as the camera's dx/dy.
 */
export function autoAlign(layout: Layout, src: Record<Camera, Src | undefined>, all: Camera[], range = 0.12): Record<string, [number, number, number]> {
  const W = 480, H = Math.round(W * layoutAspect(layout));
  const have = new Set([...all, ...Object.keys(src).filter(k => src[k])]);
  const cams = [...CAMERAS, ...[...have].filter(k => !CAMERAS.includes(k))].filter(k => have.has(k));
  const p = plan(W, H, layout, cams.includes('front') ? 'front' : cams[0], cams);
  const base = new OffscreenCanvas(W, H), bc = base.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
  const tmp = new OffscreenCanvas(W, H), tc = tmp.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
  bc.fillStyle = '#000'; bc.fillRect(0, 0, W, H);
  // alignment order: unfeathered cells first (anchors), then outward in plan order
  const order = [...p.cells.filter(c => !c.f), ...p.cells.filter(c => c.f)];
  const out: Record<string, [number, number, number]> = {};
  const edges = (d: Uint8ClampedArray, w: number, h: number) => {
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4, L = (k: number) => d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11;
      g[y * w + x] = Math.abs(L(i + 4) - L(i - 4)) + Math.abs(L(i + 4 * w) - L(i - 4 * w));
    }
    let m = 0; for (const v of g) m += v; m = m / g.length || 1; for (let k = 0; k < g.length; k++) g[k] /= m; // normalise contrast
    return g;
  };
  for (const cell of order) {
    const s = src[cell.cam]; const pr = stitchPref(cell.cam, stitchGroup(layout));
    if (!s) continue;
    if (!cell.f || cell.cam === 'front') { fit(bc, s, cell.r, undefined, cell.cover, [pr.dx, pr.dy, pr.z, pr.kl, pr.kr, pr.rot, pr.p], cell.cam, cell.mirror, false); continue; }
    const [x, y, w, h] = cell.r, f = cell.f.map(v => v * pr.b);
    // overlap band(s) in canvas coords
    const band: Rect = f[0] > 0 ? [x, y, Math.max(4, f[0]), h] : [x, y, w, Math.max(4, f[2])];
    const bx = Math.max(0, Math.floor(band[0])), by = Math.max(0, Math.floor(band[1])), bw = Math.min(W - bx, Math.ceil(band[2])), bh = Math.min(H - by, Math.ceil(band[3]));
    if (bw < 3 || bh < 3) { fit(bc, s, cell.r, undefined, true, [pr.dx, pr.dy, pr.z, pr.kl, pr.kr, pr.rot, pr.p], cell.cam, cell.mirror, false); continue; }
    // Compare row profiles of horizontal edges (barrier tops, lane lines, horizon) across the band: robust to the
    // different viewing angles of neighbouring cameras, which make pixel-level matching unreliable.
    const prof = (d: Uint8ClampedArray) => {
      const r = new Float32Array(bh);
      for (let yy = 1; yy < bh - 1; yy++) { let a = 0; for (let xx = 0; xx < bw; xx++) { const i = (yy * bw + xx) * 4, L = (k: number) => d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11; a += Math.abs(L(i + 4 * bw) - L(i - 4 * bw)); } r[yy] = a / bw; }
      let m = 0; for (const v of r) m += v; m /= bh; let sd = 0; for (const v of r) sd += (v - m) ** 2; sd = Math.sqrt(sd / bh) || 1;
      return r.map(v => (v - m) / sd);
    };
    const vert = f[0] > 0; // side-by-side seam: match vertical position; stacked seam: fall back to 2-D edge match
    const ref = vert ? prof(bc.getImageData(bx, by, bw, bh).data) : edges(bc.getImageData(bx, by, bw, bh).data, bw, bh);
    const score = (dx: number, dy: number) => {
      tc.clearRect(bx, by, bw, bh);
      fit(tc, s, cell.r, undefined, true, [dx, dy, pr.z, pr.kl, pr.kr, pr.rot, pr.p], cell.cam, cell.mirror, false);
      const d = tc.getImageData(bx, by, bw, bh).data;
      if (vert) { const g = prof(d); let c = 0; for (let k = 0; k < g.length; k++) c += g[k] * ref[k]; return -c / g.length; }
      const g = edges(d, bw, bh); let e = 0; for (let k = 0; k < g.length; k++) e += Math.abs(g[k] - ref[k]);
      return e / g.length;
    };
    let best = [pr.dx, pr.dy], bs = score(pr.dx, pr.dy);
    for (const st of [range / 10, range / 40]) {
      const [cx, cy] = best;
      for (let i = vert ? 0 : -4; i <= (vert ? 0 : 4); i++) for (let j = -10; j <= 10; j++) {
        const dx = Math.max(-range, Math.min(range, cx + i * st)), dy = Math.max(-range, Math.min(range, cy + j * st));
        const e = score(dx, dy); if (e < bs) { bs = e; best = [dx, dy]; }
      }
    }
    out[cell.cam] = [best[0], best[1], bs];
    fit(bc, s, cell.r, undefined, true, [best[0], best[1], pr.z, pr.kl, pr.kr, pr.rot, pr.p], cell.cam, cell.mirror, false);
  }
  return out;
}
