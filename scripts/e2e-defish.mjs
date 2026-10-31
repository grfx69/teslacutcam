// Fisheye / skew correction: per-camera toggles change only the chosen cameras, persist across reload,
// and apply to exports. Uses real footage (../test-footage by default).
import { chromium } from 'playwright';
import { startServer, assert, watch, openFolder, exportTo, probe, frameAt, diff, savePng } from './lib.mjs';
const FOLDER = process.argv[2] || '../test-footage', OUT = '/workspace/feat', URL = 'http://localhost:8123/';
const srv = await startServer();
const browser = await chromium.launch();
const errors = []; let ok = true;
const grab = (page) => page.evaluate(() => { const c = document.getElementById('screen'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 16 === 0)); });
const d = (a, b, y0, y1) => { const n = a.length, s = Math.floor(n * y0), e = Math.floor(n * y1); let t = 0; for (let i = s; i < e; i++) t += Math.abs(a[i] - b[i]); return t / (e - s); };
const setDf = (page, cams) => page.evaluate(cams => { document.querySelectorAll('.dfcb').forEach(cb => { if (cb.checked !== cams.includes(cb.value)) cb.click(); }); }, cams);
const openEv = async page => { await page.click('.ev >> nth=0'); await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await page.waitForTimeout(1200); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, errors);
  await page.goto(URL); await openFolder(page, FOLDER); await openEv(page);
  await page.selectOption('#layout', 'theater'); await page.waitForTimeout(400);
  const def = await page.$$eval('.dfcb', e => e.filter(x => x.checked).length);
  assert(def === 0, 'all fisheye toggles off by default');
  const base = await grab(page);
  await setDf(page, ['back']); await page.waitForTimeout(400);
  const rear = await grab(page);
  console.log(`  rear on: top(front) diff ${d(base, rear, 0, 0.3).toFixed(2)}, bottom(rear) diff ${d(base, rear, 0.8, 1).toFixed(2)}`);
  assert(d(base, rear, 0.8, 1) > 0.5 && d(base, rear, 0, 0.3) < 0.5, 'Rear toggle corrects only the rear camera in the live view');
  await page.locator('#screen').screenshot({ path: 'screenshots/r5-defish-rear.png' });
  await setDf(page, ['back', 'left_pillar', 'left_repeater']); await page.waitForTimeout(400);
  const left = await grab(page);
  await setDf(page, ['back', 'left_pillar', 'left_repeater', 'right_pillar', 'right_repeater']); await page.waitForTimeout(400);
  const all = await grab(page);
  console.log(`  left added: mid diff ${d(rear, left, 0.35, 0.75).toFixed(2)}; right added: mid diff ${d(left, all, 0.35, 0.75).toFixed(2)}`);
  assert(d(rear, left, 0.35, 0.75) > 0.3 && d(left, all, 0.35, 0.75) > 0.3, 'left-side and right-side toggles each change their cameras independently');
  await page.locator('#screen').screenshot({ path: 'screenshots/r5-defish-all.png' });
  await setDf(page, []); await page.waitForTimeout(300);
  await page.locator('#screen').screenshot({ path: 'screenshots/r5-defish-off.png' });
  await page.locator('#defishBox').screenshot({ path: 'screenshots/r5-defish-controls.png' });
  await setDf(page, ['back', 'right_repeater']);
  await page.reload(); await page.waitForSelector('.dfcb');
  const kept = await page.$$eval('.dfcb', e => e.filter(x => x.checked).map(x => x.value));
  assert(kept.join() === 'back,right_repeater', `choices persist across reload (${kept})`);
  await openFolder(page, FOLDER); await openEv(page);
  const setup = async p => { await p.selectOption('#xLayout', 'theater'); };
  await setDf(page, ['back', 'left_pillar', 'left_repeater', 'right_pillar', 'right_repeater']);
  await exportTo(page, `${OUT}/defish-on.mp4`, setup);
  await setDf(page, []);
  await exportTo(page, `${OUT}/defish-off.mp4`, setup);
  for (const n of ['on', 'off']) { const r = probe(`${OUT}/defish-${n}.mp4`); assert(r.mono && r.decodeErrors === 0 && r.frames > 0, `defish-${n} export valid (${r.frames} frames)`); savePng(`${OUT}/defish-${n}.mp4`, 1, `screenshots/r5-export-defish-${n}.png`); }
  const a = frameAt(`${OUT}/defish-on.mp4`, 1), b = frameAt(`${OUT}/defish-off.mp4`, 1);
  const top = diff(a, b, [0, 0, 1, 0.25]), bot = diff(a, b, [0, 0.8, 1, 1]);
  console.log(`  export diff: front ${top.toFixed(2)}, rear ${bot.toFixed(2)}`);
  assert(bot > 0.5 && bot > top * 1.5, 'export applies the correction to the corrected cameras only');
} catch (e) { ok = false; console.error(e); }
console.log('console errors:', errors);
await browser.close(); srv.kill();
process.exit(ok && !errors.length ? 0 : 1);
