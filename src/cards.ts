// Title / end cards for exports.
export interface CardOpts {
  on: boolean; style: 'logo' | 'logo+text' | 'text';
  title: string; subtitle: string; duration: number;
  font: string; size: number; color: string;
  bg: 'black' | 'solid' | 'blur'; bgColor: string;
}
export const defaultTitle: CardOpts = { on: false, style: 'text', title: 'My Tesla drive', subtitle: '', duration: 3, font: 'system-ui', size: 72, color: '#ffffff', bg: 'blur', bgColor: '#101418' };
export const defaultEnd: CardOpts = { ...defaultTitle, title: 'Thanks for watching', duration: 2, bg: 'black' };
export const FONTS = ['system-ui', 'Georgia', 'Arial Black', 'Courier New', 'Impact', 'Trebuchet MS'];

/** Draws a card filling (0,0,W,H). size is the title size in px at 1080p height and scales with H. */
export function drawCard(c: CanvasRenderingContext2D, W: number, H: number, o: CardOpts, logo: CanvasImageSource & { width: number; height: number } | null, bg: CanvasImageSource | null, alpha = 1) {
  c.save();
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  if (o.bg === 'solid') { c.fillStyle = o.bgColor; c.fillRect(0, 0, W, H); }
  else if (o.bg === 'blur' && bg) {
    c.filter = `blur(${Math.round(Math.max(W, H) / 60)}px) brightness(0.55)`;
    c.drawImage(bg, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1); c.filter = 'none';
  }
  c.globalAlpha = alpha;
  const k = H / 1080, ts = Math.max(12, o.size * k), ss = ts * 0.45;
  const wantLogo = o.style !== 'text' && logo && logo.width, wantText = o.style !== 'logo';
  const lh = wantLogo ? (wantText ? H * 0.32 : H * 0.5) : 0;
  const lw = wantLogo ? Math.min(W * 0.6, lh * logo!.width / logo!.height) : 0, lhh = wantLogo ? lw * logo!.height / logo!.width : 0;
  const textH = wantText ? ts * 1.2 + (o.subtitle ? ss * 1.6 : 0) : 0, gap = wantLogo && wantText ? H * 0.04 : 0;
  let y = (H - lhh - gap - textH) / 2;
  if (wantLogo) { c.drawImage(logo!, (W - lw) / 2, y, lw, lhh); y += lhh + gap; }
  if (wantText) {
    c.fillStyle = o.color; c.textAlign = 'center'; c.textBaseline = 'top';
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 8 * k;
    c.font = `700 ${ts}px "${o.font}", system-ui, sans-serif`; c.fillText(o.title, W / 2, y, W * 0.9);
    if (o.subtitle) { c.font = `400 ${ss}px "${o.font}", system-ui, sans-serif`; c.globalAlpha = alpha * 0.85; c.fillText(o.subtitle, W / 2, y + ts * 1.25, W * 0.9); }
  }
  c.restore();
}
