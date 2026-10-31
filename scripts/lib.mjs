// shared helpers for the Tesla Cut Cam Export e2e scripts
import { spawn, execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
mkdirSync('screenshots', { recursive: true });
export const startServer = (env = {}) => {
  const p = spawn('python3', ['server/teslacutcam-server.py'], { stdio: 'ignore', env: { ...process.env, TCC_SITE: 'dist', TCC_STRICT_PORT: '1', TESLACAM_GEO_KEY: '', ...env } });
  return new Promise(r => setTimeout(() => r(p), 900));
};
export const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); console.log('  ok:', m); };
export function watch(page, errors) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
}
export async function openFolder(page, folder) {
  await page.setInputFiles('#dirInput', folder);
  await page.waitForSelector('.ev');
}
export async function openEvent(page, match) {
  const evs = await page.$$eval('.ev', els => els.map(e => e.textContent));
  const k = evs.findIndex(t => t.includes(match)); if (k < 0) throw new Error('no event ' + match + ' in ' + evs);
  await page.click(`.ev >> nth=${k}`); await page.waitForTimeout(150);
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await page.waitForTimeout(600);
}
/** opens the export dialog, runs setup(page), exports and saves to path. returns __lastExport */
export async function exportTo(page, path, setup = async () => {}, timeout = 900000) {
  await page.click('#export');
  await setup(page);
  const dl = page.waitForEvent('download', { timeout });
  await page.click('#xGo');
  const res = await Promise.race([dl, page.waitForSelector('#err', { state: 'visible', timeout }).then(() => null)]);
  if (!res) throw new Error('export error: ' + await page.evaluate(() => window.__lastError));
  await res.saveAs(path);
  return page.evaluate(() => { const { blob, ...r } = window.__lastExport; return r; });
}
/** set a control inside the export dialog (works for collapsed <details>) */
export const setCtl = (page, id, v) => page.evaluate(([id, v]) => {
  const el = document.getElementById(id);
  if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, v]);
/** frame count, duration and whether DTS is strictly increasing + ffmpeg decodes cleanly */
export function probe(path) {
  const pk = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=dts', '-of', 'csv=p=0', path]).toString().trim().split('\n').map(Number);
  let mono = true; for (let i = 1; i < pk.length; i++) if (!(pk[i] > pk[i - 1])) mono = false;
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim().split(',').map(Number);
  const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString();
  const r = spawnSyncErr(path);
  return { frames: pk.length, mono, w, h, dur, decodeErrors: r };
}
function spawnSyncErr(path) {
  try { return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').filter(Boolean).length; }
  catch (e) { return 999; }
}
/** RGB24 pixels of the frame at time t, scaled to w×h */
export function frameAt(path, t, w = 320, h = 180) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  return { w, h, d: buf };
}
export function savePng(path, t, out) { execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', path, '-frames:v', '1', out]); }
/** fraction of pixels in rect (fractions of frame) matching pred(r,g,b) */
export function frac(f, pred, [x0, y0, x1, y1] = [0, 0, 1, 1]) {
  let n = 0, m = 0;
  for (let y = Math.floor(y0 * f.h); y < Math.floor(y1 * f.h); y++) for (let x = Math.floor(x0 * f.w); x < Math.floor(x1 * f.w); x++) { const i = (y * f.w + x) * 3; n++; if (pred(f.d[i], f.d[i + 1], f.d[i + 2])) m++; }
  return m / Math.max(1, n);
}
export function diff(a, b, [x0, y0, x1, y1] = [0, 0, 1, 1]) {
  let s = 0, n = 0;
  for (let y = Math.floor(y0 * a.h); y < Math.floor(y1 * a.h); y++) for (let x = Math.floor(x0 * a.w); x < Math.floor(x1 * a.w); x++) { const i = (y * a.w + x) * 3; for (let c = 0; c < 3; c++) s += Math.abs(a.d[i + c] - b.d[i + c]); n += 3; }
  return s / Math.max(1, n);
}
