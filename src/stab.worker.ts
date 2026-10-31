// Global-motion estimator for video stabilisation (runs off the main thread).
// For each camera it compares the new downscaled grey frame with the previous one by block matching
// (mean-normalised SAD over a central window, ±R px search, parabolic sub-pixel refinement) and
// returns the content shift in downscaled pixels.
const prev: Record<string, Float32Array> = {};
const R = 8;
self.onmessage = (e: MessageEvent) => {
  const { id, cam, w, h, gray, reset } = e.data;
  if (reset) { for (const k of Object.keys(prev)) delete prev[k]; return; }
  const g = new Float32Array(gray.length); let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i]; mean /= gray.length;
  for (let i = 0; i < gray.length; i++) g[i] = gray[i] - mean;
  const p = prev[cam]; prev[cam] = g;
  if (!p) return (self as any).postMessage({ id, dx: 0, dy: 0, conf: 0 });
  const m = R + 2, cost = new Float32Array((2 * R + 1) ** 2);
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    let sum = 0;
    for (let y = m; y < h - m; y += 2) { const r0 = y * w, r1 = (y + dy) * w + dx; for (let x = m; x < w - m; x += 2) sum += Math.abs(g[r0 + x] - p[r1 + x]); }
    cost[(dy + R) * (2 * R + 1) + dx + R] = sum;
    if (sum < best) { best = sum; bx = dx; by = dy; }
  }
  const C = (dx: number, dy: number) => cost[(dy + R) * (2 * R + 1) + dx + R];
  const sub = (a: number, b: number, c: number) => { const d = a - 2 * b + c; return d > 0 ? (a - c) / (2 * d) : 0; };
  let fx = bx, fy = by;
  if (Math.abs(bx) < R) fx += sub(C(bx - 1, by), best, C(bx + 1, by));
  if (Math.abs(by) < R) fy += sub(C(bx, by - 1), best, C(bx, by + 1));
  // current(x) ≈ prev(x + d)  ⇒  content moved by -d
  (self as any).postMessage({ id, dx: -fx, dy: -fy, conf: Math.abs(bx) < R && Math.abs(by) < R ? 1 : 0 });
};
