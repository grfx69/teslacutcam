import { defish, defishOn } from './defish';
import { camLabel, CAMERAS, type Camera } from './library';

export type Layout = 'theater' | 'single' | 'grid' | 'pip';
type Src = CanvasImageSource & ({ videoWidth: number; videoHeight: number } | { displayWidth: number; displayHeight: number });
export type Rect = [number, number, number, number];
/** per-camera stabilisation transform: shift (fraction of the drawn image) and zoom */
export type Xf = [number, number, number];

function dims(s: Src): [number, number] {
  return 'videoWidth' in s ? [s.videoWidth, s.videoHeight] : [s.displayWidth, s.displayHeight];
}
/** draw s into rect; cover=true fills the rect (centre crop), else letterboxes */
function fit(c: CanvasRenderingContext2D, s: Src | undefined, [x, y, w, h]: Rect, label?: string, cover = false, xf?: Xf, cam?: string) {
  c.fillStyle = '#000'; c.fillRect(x, y, w, h);
  if (s) {
    const [sw, sh] = dims(s);
    if (sw && sh) {
      const k = cover ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh), bw = sw * k, bh = sh * k;
      const z = xf?.[2] ?? 1, dw = bw * z, dh = bh * z;
      const ox = (xf?.[0] ?? 0) * dw, oy = (xf?.[1] ?? 0) * dh;
      c.save(); c.beginPath(); c.rect(x + (w - Math.min(w, bw)) / 2, y + (h - Math.min(h, bh)) / 2, Math.min(w, bw), Math.min(h, bh)); c.clip();
      const img = cam && defishOn(cam) ? defish(s as TexImageSource, sw, sh) ?? s : s;
      c.drawImage(img, x + (w - dw) / 2 + ox, y + (h - dh) / 2 + oy, dw, dh);
      c.restore();
    }
  }
  if (label) {
    const fs = Math.max(11, Math.round(Math.min(h / 12, 18)));
    c.font = `600 ${fs}px system-ui, sans-serif`;
    const tw = c.measureText(label).width;
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x + w - tw - 18, y + 6, tw + 12, fs + 8);
    c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(label, x + w - tw - 12, y + 10 + fs / 2);
  }
  c.strokeStyle = '#000'; c.lineWidth = 2; c.strokeRect(x, y, w, h);
}

/** Output aspect (H/W) per layout. Theater is taller so every camera gets a usable size. */
export const layoutAspect = (l: Layout) => l === 'theater' ? 0.9 : 9 / 16;

export interface Plan { cells: { cam: Camera; r: Rect; cover: boolean }[]; hud: Rect; }

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
  // theater
  const left = ['left_pillar', 'left_repeater'].filter(has), right = ['right_pillar', 'right_repeater'].filter(has);
  const extra = cams.filter(c => !['front', 'back', ...left, ...right].includes(c)); // e.g. front_wide
  const front = has('front') ? 'front' : cams[0];
  const rear = has('back') ? 'back' : undefined;
  const sideRows = Math.max(left.length, right.length, extra.length ? 1 : 0);
  const fH = H * (rear ? 0.32 : 0.45), rH = rear ? H * 0.32 : 0;
  const midH = H - fH - rH;
  cells.push({ cam: front, r: [0, 0, W, fH], cover: true });
  const ex = extra.filter(c => c !== front);
  const cols: Camera[][] = [left, ...(ex.length ? [ex] : []), right].filter(c => c.length);
  const cw = W / Math.max(1, cols.length);
  cols.forEach((col, ci) => {
    const rh = midH / (col === ex ? ex.length : sideRows || 1);
    col.forEach((c, ri) => cells.push({ cam: c, r: [ci * cw, fH + ri * rh, cw, rh], cover: true }));
  });
  if (rear) cells.push({ cam: rear, r: [0, H - rH, W, rH], cover: true });
  return { cells, hud: [0, 0, W, fH] };
}

export function compose(c: CanvasRenderingContext2D, W: number, H: number, layout: Layout, main: Camera, src: Record<Camera, Src | undefined>, xf: Record<Camera, Xf> = {}): Rect {
  const cams = [...CAMERAS, ...Object.keys(src).filter(k => !CAMERAS.includes(k))].filter(k => src[k]);
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const p = plan(W, H, layout, main, cams);
  const showLabels = p.cells.length > 1;
  for (const cell of p.cells) fit(c, src[cell.cam], cell.r, showLabels ? camLabel(cell.cam) : undefined, cell.cover, xf[cell.cam], cell.cam);
  return p.hud;
}
