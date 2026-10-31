// Optional stabilisation for exports. Tesla dashcam telemetry has no gyroscope (only speed, pedal,
// steering, GPS, heading and linear acceleration), so the practical method is video-based: estimate
// global frame-to-frame motion in a worker, low-pass the camera path, and shift + zoom (crop) each
// stabilised camera by the difference. Roll is not corrected.
import StabWorker from './stab.worker?worker';
import type { Camera } from './library';
import type { Xf } from './compose';

export interface StabOpts { on: boolean; strength: number; crop: number; cams: 'main' | 'all'; }
export const defaultStab: StabOpts = { on: false, strength: 0.7, crop: 0.08, cams: 'main' };
const SW = 160, SH = 90;

export class Stabilizer {
  private w = new StabWorker();
  private id = 0; private pending = new Map<number, (v: { dx: number; dy: number }) => void>();
  private path: Record<Camera, { px: number; py: number; sx: number; sy: number }> = {};
  private small = new OffscreenCanvas(SW, SH);
  private sctx = this.small.getContext('2d', { willReadFrequently: true })! as OffscreenCanvasRenderingContext2D;
  private frames = 0; private maxCorr = 0;
  constructor(private o: StabOpts) { this.w.onmessage = e => { this.pending.get(e.data.id)?.(e.data); this.pending.delete(e.data.id); }; }
  reset() { this.w.postMessage({ reset: true }); this.path = {}; }
  private measure(cam: Camera, f: VideoFrame) {
    this.sctx.drawImage(f, 0, 0, SW, SH);
    const d = this.sctx.getImageData(0, 0, SW, SH).data, g = new Uint8Array(SW * SH);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const id = ++this.id;
    return new Promise<{ dx: number; dy: number }>(r => { this.pending.set(id, r); this.w.postMessage({ id, cam, w: SW, h: SH, gray: g }, [g.buffer]); });
  }
  async step(frames: Record<Camera, VideoFrame>, main: Camera): Promise<Record<Camera, Xf>> {
    const out: Record<Camera, Xf> = {}, list = this.o.cams === 'all' ? Object.keys(frames) : [main].filter(c => frames[c]);
    const alpha = 1 - Math.min(0.98, Math.max(0, this.o.strength) * 0.97), lim = this.o.crop / 2, z = 1 + this.o.crop;
    await Promise.all(list.map(async c => {
      const m = await this.measure(c, frames[c]);
      const p = this.path[c] ??= { px: 0, py: 0, sx: 0, sy: 0 };
      p.px += m.dx; p.py += m.dy;
      p.sx += alpha * (p.px - p.sx); p.sy += alpha * (p.py - p.sy);
      let cx = (p.sx - p.px) / SW, cy = (p.sy - p.py) / SH;
      // keep the correction inside the crop margin; pull the smoothed path along when it hits the edge
      if (Math.abs(cx) > lim) { cx = Math.sign(cx) * lim; p.sx = p.px + cx * SW; }
      if (Math.abs(cy) > lim) { cy = Math.sign(cy) * lim; p.sy = p.py + cy * SH; }
      this.maxCorr = Math.max(this.maxCorr, Math.abs(cx), Math.abs(cy));
      out[c] = [cx, cy, z];
    }));
    this.frames++;
    return out;
  }
  summary() { return `video motion tracking, ${this.frames} frames, max correction ${(this.maxCorr * 100).toFixed(1)}%`; }
  close() { this.w.terminate(); }
}
