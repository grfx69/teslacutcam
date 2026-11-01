import { defish, defishOn } from './defish';
import { camLabel, CAMERAS, type Camera } from './library';

export type Layout = 'theater' | 'single' | 'grid' | 'pip' | 'stitch' | 'pano' | 'panorear';
/** mirror the rear camera in stitched layouts (rear-view-mirror orientation lines its left edge up with the left repeater) */
export const rearMirror = () => { try { return localStorage.getItem('tcc.rearMirror') !== '0'; } catch { return true; } };
type Src = CanvasImageSource & ({ videoWidth: number; videoHeight: number } | { displayWidth: number; displayHeight: number });
export type Rect = [number, number, number, number];
/** per-camera stabilisation transform: shift (fraction of the drawn image) and zoom */
export type Xf = [number, number, number];

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
      c.drawImage(img, x + (w - dw) / 2 + ox, y + (h - dh) / 2 + oy, dw, dh);
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
export const layoutAspect = (l: Layout) => l === 'theater' || l === 'stitch' ? 0.9 : l === 'pano' ? 0.3 : l === 'panorear' ? 0.6 : 9 / 16;

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
  if (layout === 'pano' || layout === 'panorear') {
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

export function compose(c: CanvasRenderingContext2D, W: number, H: number, layout: Layout, main: Camera, src: Record<Camera, Src | undefined>, xf: Record<Camera, Xf> = {}, all: Camera[] = []): Rect {
  // Lay out every camera the event has (not only the ones with a frame right now), so a camera that is
  // missing from one clip or failed to decode keeps its slot (shown as 'No video') instead of vanishing.
  const have = new Set([...all, ...Object.keys(src).filter(k => src[k])]);
  const cams = [...CAMERAS, ...[...have].filter(k => !CAMERAS.includes(k))].filter(k => have.has(k));
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const p = plan(W, H, layout, main, cams);
  if (typeof window !== "undefined" && W > 0) (window as any).__lastPlan = { W, H, cells: p.cells.map(c => ({ cam: c.cam, r: c.r })) };
  const showLabels = p.cells.length > 1;
  const stitched = p.cells.some(x => x.f);
  p.cells.forEach((cell, i) => {
    const lab = showLabels && !stitched ? camLabel(cell.cam) : undefined;
    if (!cell.f) return fit(c, src[cell.cam], cell.r, lab, cell.cover, xf[cell.cam], cell.cam, cell.mirror, !stitched);
    feathered(c, i, src[cell.cam], cell.r, cell.f, xf[cell.cam], cell.cam, !!cell.mirror);
  });
  if (stitched && showLabels) for (const cell of p.cells) tag(c, cell.r, camLabel(cell.cam) + (cell.mirror ? ' (mirrored)' : ''), cell.f);
  return p.hud;
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
