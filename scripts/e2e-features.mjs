// Round-4 feature tests: defaults, No HUD, map, speed ramps, stabilization, title cards, Sentry sheet/batch,
// open last folder, unsupported browser. Uses ../test-feat (copies of the real clips; see README "Testing").
import { chromium } from 'playwright';
import { readdirSync } from 'fs';
import { startServer, assert, watch, openFolder, openEvent, exportTo, setCtl, probe, frameAt, frac, diff, savePng } from './lib.mjs';
const FOLDER = process.argv[2] || '../test-feat', OUT = '/workspace/feat', URL = 'http://localhost:8123/';
import { mkdirSync } from 'fs'; mkdirSync(OUT, { recursive: true });
const srv = await startServer();
const browser = await chromium.launch();
const errors = []; let ok = true;
const newPage = async (init) => { const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true }); if (init) await ctx.addInitScript(init); const p = await ctx.newPage(); watch(p, errors); return p; };
const valid = (p, name) => { const r = probe(p); assert(r.mono && r.decodeErrors === 0 && r.frames > 0, `${name}: valid MP4 (${r.frames} frames, ${r.dur.toFixed(2)} s, ${r.w}×${r.h}, DTS strictly increasing, 0 decode errors)`); return r; };
const grid720 = async page => { await page.selectOption('#xLayout', 'grid'); await page.selectOption('#xRes', '1280x720'); };
try {
  // ---------- defaults ----------
  let page = await newPage();
  await page.goto(URL); await openFolder(page, FOLDER); await openEvent(page, '8:35:44 PM');
  await page.click('#export');
  const d = await page.evaluate(() => ({ map: document.querySelector('#xItems input[data-k=map]')?.checked, ramp: xRamp.checked, stab: xStab.checked, title: xTitle.checked, end: xEnd.checked, hudOn: xHudOn.checked, perf: window.__teslacutcam.features.perf, remember: window.__teslacutcam.features.remember }));
  console.log('defaults', d);
  assert(d.map === false && !d.ramp && !d.stab && !d.title && !d.end && d.hudOn && d.perf === 'auto' && !d.remember, 'all new features off by default (Map unchecked), HUD on, perf Auto');
  await page.locator('#exportDlg').screenshot({ path: 'screenshots/r4-export-dialog-defaults.png' });
  await page.click('#exportDlg button[value=cancel]');

  // ---------- No HUD vs HUD, and map ----------
  const hud = await exportTo(page, `${OUT}/drive-hud.mp4`, async p => { await grid720(p); await p.check('#xHudOn'); });
  valid(`${OUT}/drive-hud.mp4`, 'HUD export');
  const nohud = await exportTo(page, `${OUT}/drive-nohud.mp4`, async p => { await grid720(p); await p.check('#xHudOff'); });
  valid(`${OUT}/drive-nohud.mp4`, 'No HUD export');
  const map = await exportTo(page, `${OUT}/drive-map.mp4`, async p => { await grid720(p); await p.check('#xHudOn'); await p.check('#xItems input[data-k=map]'); });
  valid(`${OUT}/drive-map.mp4`, 'map export');
  const tr = await page.evaluate(() => window.__teslacutcam.trail);
  assert(tr && tr.n > 1, `breadcrumb trail built from GPS (${tr?.n} points)`);
  const fH = frameAt(`${OUT}/drive-hud.mp4`, 1.5), fN = frameAt(`${OUT}/drive-nohud.mp4`, 1.5), fM = frameAt(`${OUT}/drive-map.mp4`, 1.5);
  for (const [f, n] of [[`${OUT}/drive-hud.mp4`, 'hud'], [`${OUT}/drive-nohud.mp4`, 'nohud'], [`${OUT}/drive-map.mp4`, 'map']]) savePng(f, 1.5, `screenshots/r4-frame-${n}.png`);
  const dh = diff(fH, fN), dm = diff(fH, fM, [0.75, 0, 1, 0.3]), dmOther = diff(fH, fM, [0, 0.5, 0.25, 1]);
  console.log(`  hud vs nohud mean diff ${dh.toFixed(2)}, map corner diff ${dm.toFixed(2)} (elsewhere ${dmOther.toFixed(2)})`);
  assert(dh > 1, 'No HUD export has no HUD pixels (differs from HUD export)');
  assert(dm > 4 && dm > dmOther * 3, 'map panel drawn in the top-right corner');
  await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('teslacam.overlay') || '{}'); }); 
  // live map: switch on in live overlay
  await page.evaluate(() => { const i = document.querySelector('#items input[data-k=map], [data-k=map]'); if (i) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.waitForTimeout(500); await page.screenshot({ path: 'screenshots/r4-live-map.png' });

  // ---------- stabilization ----------
  const st = await exportTo(page, `${OUT}/drive-stab.mp4`, async p => { await grid720(p); await setCtl(p, 'xStab', true); await setCtl(p, 'xStabCams', 'all'); });
  valid(`${OUT}/drive-stab.mp4`, 'stabilized export'); console.log('  stab summary:', st.stab);
  assert(!!st.stab && diff(frameAt(`${OUT}/drive-stab.mp4`, 1.5), fH) > 1, 'stabilization ran and changed the image (crop-zoom)');
  savePng(`${OUT}/drive-stab.mp4`, 1.5, 'screenshots/r4-frame-stab.png');
  await page.click('#export'); await setCtl(page, 'xStab', false); await page.click('#exportDlg button[value=cancel]');

  // ---------- title cards ----------
  const white = (r, g, b) => r > 200 && g > 200 && b > 200, red = (r, g, b) => r > 180 && g < 70 && b < 70;
  const cardRun = async (style, withLogo) => {
    const f = `${OUT}/card-${style}.mp4`;
    await exportTo(page, f, async p => {
      await grid720(p);
      await p.evaluate(() => document.querySelectorAll('#exportDlg details').forEach(d => d.open = true));
      if (withLogo) await p.setInputFiles('#xLogo', '/workspace/test-logo.png'); else await p.evaluate(() => document.getElementById('xLogoClear').click());
      await p.waitForTimeout(300);
      await setCtl(p, 'xTitle', true); await setCtl(p, 'xCardStyle', style); await setCtl(p, 'xCardTitle', 'TEST CARD'); await setCtl(p, 'xCardSub', 'subtitle');
      await setCtl(p, 'xCardBg', 'black'); await setCtl(p, 'xCardDur', '2'); await setCtl(p, 'xCardColor', '#ffffff');
      if (style === 'text') await p.locator('#xCardPreview').screenshot({ path: 'screenshots/r4-card-preview.png' });
    });
    const r = valid(f, `title card ${style}`); savePng(f, 1.0, `screenshots/r4-card-${style}.png`);
    const fr = frameAt(f, 1.0); return { w: frac(fr, white), r: frac(fr, red), dur: r.dur };
  };
  const ct = await cardRun('text', false), cl = await cardRun('logo', true), clt = await cardRun('logo+text', true);
  console.log('  card pixels (white text / red logo fraction):', { text: ct, logo: cl, logoText: clt });
  assert(ct.w > 0.001 && ct.r < 0.0005, 'text-only card: text, no logo');
  assert(cl.r > 0.01 && cl.w < 0.0005, 'logo-only card: logo, no text');
  assert(clt.r > 0.005 && clt.w > 0.001, 'logo + text card: both');
  assert(ct.dur > hud.seconds + 1.5, 'card adds ~2 s to the export');
  await page.click('#export'); await setCtl(page, 'xTitle', false); await page.click('#exportDlg button[value=cancel]');

  // ---------- speed ramps (Sentry trigger at 05:44:07, 2 s in) ----------
  await openEvent(page, '5:44:05 AM');
  const base = await exportTo(page, `${OUT}/sentry-base.mp4`, grid720);
  const rp = await exportTo(page, `${OUT}/sentry-ramp.mp4`, async p => {
    await grid720(p); await setCtl(p, 'xRamp', true); await setCtl(p, 'xRampFactor', '0.25');
    await p.waitForTimeout(300);
    console.log('  ramp info:', await p.textContent('#xRampInfo'));
    await p.locator('#exportDlg').screenshot({ path: 'screenshots/r4-ramp-dialog.png' });
  });
  const trig = await page.evaluate(() => window.__teslacutcam.triggers);
  assert(trig.some(t => t.type === 'sentry' && Math.abs(t.t - 2) < 0.2), `Sentry trigger found at 2 s (${JSON.stringify(trig)})`);
  const box = await page.locator('#track').boundingBox();
  await page.screenshot({ path: 'screenshots/r4-ramp-timeline.png', clip: { x: 0, y: box.y - 20, width: 1500, height: box.height + 40 } });
  const orange = await page.evaluate(() => { const c = document.querySelector('#track canvas') || document.getElementById('track'); if (!(c instanceof HTMLCanvasElement)) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 100 && d[i + 1] < 190 && d[i + 2] < 80) n++; return n; });
  console.log('  orange marker pixels on timeline:', orange);
  assert(orange !== 0, 'ramp marker drawn on the timeline');
  const vb = valid(`${OUT}/sentry-base.mp4`, 'unramped'), vr = valid(`${OUT}/sentry-ramp.mp4`, 'ramped');
  assert(vr.frames > vb.frames * 1.4 && vr.dur > vb.dur + 1, `ramp slows the trigger moment (frames ${vb.frames} → ${vr.frames}, ${vb.dur.toFixed(1)} → ${vr.dur.toFixed(1)} s)`);
  await page.click('#export'); await setCtl(page, 'xRamp', false); await page.click('#exportDlg button[value=cancel]');
  await page.close();

  // ---------- Sentry contact sheet + batch (folder output via OPFS-backed showDirectoryPicker) ----------
  page = await newPage(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('batch-out', { create: true }); });
  await page.goto(URL); await openFolder(page, FOLDER);
  assert((await page.textContent('#sheetBtn')).includes('(2)'), 'contact sheet button shows 2 Sentry events');
  await page.click('#sheetBtn'); await page.waitForTimeout(800);
  const thumbs = await page.$$eval('#sheet .th', t => t.length);
  assert(thumbs === 2, 'contact sheet shows 2 thumbnails grouped by day');
  await page.waitForTimeout(2500); const thw = await page.$$eval('#sheet .th img', i => i.map(x => x.naturalWidth));
  assert(thw.every(w => w > 0), 'thumbnails rendered from the trigger camera when thumb.png is missing (' + thw + ')');
  await page.locator('#sheetDlg').screenshot({ path: 'screenshots/r4-sentry-sheet.png' });
  await page.click('#sheet .th >> nth=1'); await page.waitForSelector('#busy', { state: 'hidden' }); await page.waitForTimeout(800);
  const s1 = await page.evaluate(() => window.__teslacutcam.state);
  assert(Math.abs(s1.cur - 1) < 0.5, `thumbnail opens the event at trigger − 2 s (playhead ${s1.cur.toFixed(2)})`);
  await page.click('#sheetBtn'); await page.waitForTimeout(300);
  const dl1 = page.waitForEvent('download', { timeout: 300000 });
  await page.click('#sheet h4 button[data-m=combined]'); const c = await dl1; await c.saveAs(`${OUT}/sentry-day-combined.mp4`);
  await page.waitForFunction(() => window.__batch, null, { timeout: 300000 });
  const vc = valid(`${OUT}/sentry-day-combined.mp4`, 'combined day video'); assert(vc.dur > 8, 'combined video contains both events');
  await page.evaluate(() => window.__batch = null);
  const got = []; page.on('download', d => got.push(d));
  await page.click('#sheetBtn'); await page.waitForTimeout(300); await page.click('#sheet h4 button[data-m=downloads]');
  await page.waitForFunction(() => window.__batch, null, { timeout: 300000 }); await page.waitForTimeout(1500);
  for (const [i, d] of got.entries()) await d.saveAs(`${OUT}/sentry-batch-${i}.mp4`);
  assert(got.length === 2, `download one by one: ${got.map(d => d.suggestedFilename()).join(', ')}`);
  got.forEach((d, i) => valid(`${OUT}/sentry-batch-${i}.mp4`, 'batch file ' + d.suggestedFilename()));
  await page.evaluate(() => window.__batch = null);
  await page.click('#sheetBtn'); await page.waitForTimeout(300); await page.click('#sheet h4 button[data-m=files]');
  await page.waitForFunction(() => window.__batch, null, { timeout: 300000 });
  const opfs = await page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('batch-out'); const o = []; for await (const [n, h] of d) o.push([n, (await h.getFile()).size]); return o; });
  assert(opfs.length === 2 && opfs.every(([, s]) => s > 100000), `export as files wrote into chosen folder: ${JSON.stringify(opfs)}`);
  await page.close();

  // ---------- open last folder (OPFS directory handle stored in IndexedDB) ----------
  page = await newPage();
  await page.goto(URL);
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'tmpIn'; document.body.append(i); });
  const sdir = `${FOLDER}/SentryClips/2026-06-16_05-44-17`;
  await page.setInputFiles('#tmpIn', readdirSync(sdir).map(f => `${sdir}/${f}`));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await (await (await root.getDirectoryHandle('TeslaCam', { create: true })).getDirectoryHandle('SentryClips', { create: true })).getDirectoryHandle('2026-06-16_05-44-17', { create: true });
    for (const f of document.getElementById('tmpIn').files) { const w = await (await d.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f); await w.close(); }
  });
  await page.click('#settingsBtn'); await page.check('#remember'); await page.locator('#settings').screenshot({ path: 'screenshots/r4-settings.png' }); await page.keyboard.press('Escape');
  await page.evaluate(async () => { const h = await (await navigator.storage.getDirectory()).getDirectoryHandle('TeslaCam'); await new Promise(r => { const q = indexedDB.open('teslacutcam', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => { const t = q.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(h, 'lastFolder'); t.oncomplete = r; }; }); });
  await page.reload(); await page.waitForTimeout(800);
  assert(await page.isVisible('#lastFolder') && (await page.textContent('#lastFolder')).includes('TeslaCam'), 'Open last folder button shown after reload');
  await page.screenshot({ path: 'screenshots/r4-open-last-folder.png', clip: { x: 0, y: 0, width: 1500, height: 120 } });
  await page.click('#lastFolder'); await page.waitForSelector('.ev', { timeout: 30000 });
  assert((await page.$$('.ev')).length === 1, 'last folder reopened without a picker');
  // expired permission
  await page.evaluate(() => { FileSystemHandle.prototype.queryPermission = async () => 'prompt'; FileSystemHandle.prototype.requestPermission = async () => 'denied'; });
  await page.click('#lastFolder'); await page.waitForTimeout(500);
  const msg = await page.textContent('#stats'); console.log('  expired permission message:', msg);
  assert(/not granted/.test(msg), 'expired permission handled with a clear message');
  // folder gone (USB unplugged)
  await page.evaluate(async () => { delete FileSystemHandle.prototype.queryPermission; delete FileSystemHandle.prototype.requestPermission; await (await navigator.storage.getDirectory()).removeEntry('TeslaCam', { recursive: true }); });
  await page.click('#lastFolder'); await page.waitForTimeout(800);
  const msg2 = await page.textContent('#stats'); console.log('  missing folder message:', msg2);
  assert(/moved|not plugged/.test(msg2), 'missing folder handled with a clear message');
  await page.close();

  // ---------- unsupported browser ----------
  page = await newPage(() => { delete window.VideoEncoder; delete window.VideoDecoder; });
  await page.goto(URL); await page.waitForTimeout(800);
  const ban = await page.textContent('#unsupported');
  assert(await page.isVisible('#unsupported') && ban.length > 20, 'unsupported banner: ' + ban);
  await openFolder(page, FOLDER);
  assert(await page.isDisabled('#export'), 'Export disabled when WebCodecs is missing');
  await page.screenshot({ path: 'screenshots/r4-unsupported.png' });
  await page.close();
} catch (e) { ok = false; console.error('FAIL', e); }
const real = errors.filter(e => !/Failed to load resource.*(404|geo)/.test(e));
console.log('console errors:', real);
await browser.close(); srv.kill();
process.exit(ok && !real.length ? 0 : 1);
