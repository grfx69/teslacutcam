// End-to-end test: serves dist/, loads a TeslaCam folder, checks loading UI, cameras, theater layout,
// timeline dragging, and trimmed exports (off clip boundaries) for every event in the folder.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
const folder = process.argv[2] || '../test-footage', tag = process.argv[3] || 'run';
mkdirSync('screenshots', { recursive: true });
const srv = spawn('python3', ['server/teslacutcam-server.py'], { stdio: 'ignore', env: { ...process.env, TCC_SITE: 'dist', TCC_STRICT_PORT: '1', TESLACAM_GEO_KEY: '' } });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.text().includes('[TeslaCam]')) console.log('  page:', m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
let ok = true;
const st = () => page.evaluate(() => window.__teslacam.state);
const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); };
try {
  await page.goto('http://localhost:8123/');
  let sawBusy = false;
  page.on('framenavigated', () => {});
  const watch = setInterval(async () => { try { if (await page.isVisible('#busy')) sawBusy = true; } catch {} }, 20);
  await page.setInputFiles('#dirInput', folder);
  await page.waitForSelector('.ev');
  const evs = await page.$$eval('.ev', els => els.map(e => e.textContent));
  console.log('events:', evs);
  for (let k = 0; k < evs.length; k++) {
    await page.click(`.ev >> nth=${k}`);
    await page.waitForTimeout(100);
    await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
    await page.waitForTimeout(800);
    const s = await st();
    console.log(`[${k}] ${await page.$eval('#mode', s => s.options[0].text)} | ${await page.$eval('#layout', s => s.options[0].text)} | ${await page.textContent('#cams')}`);
    console.log(`     stats: ${await page.textContent('#stats')}`);
    await page.click('#play'); await page.waitForTimeout(1500); await page.click('#play');
    await page.screenshot({ path: `screenshots/${tag}-${k}-layout.png` });
    // timeline: drag playhead, In and Out handles
    const box = await page.locator('#track').boundingBox();
    const X = t => box.x + t / s.total * box.width, Y = box.y + box.height / 2;
    await page.mouse.move(X(s.total * 0.6), Y); await page.mouse.down(); await page.mouse.move(X(s.total * 0.45), Y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const a = await st(); assert(Math.abs(a.cur - s.total * 0.45) < 0.3, 'playhead drag ' + a.cur);
    const tin = Math.min(1.3, s.total * 0.2), tout = Math.min(s.total - 0.2, tin + 2.7);
    await page.mouse.move(X(0) + 1, Y); await page.mouse.down(); await page.mouse.move(X(tin), Y, { steps: 6 }); await page.mouse.up();
    await page.mouse.move(X(s.total) - 1, Y); await page.mouse.down(); await page.mouse.move(X(tout), Y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(500);
    const b = await st(); console.log(`     drag → in ${b.inT.toFixed(2)} out ${b.outT.toFixed(2)} playhead ${b.cur.toFixed(2)}`);
    assert(Math.abs(b.inT - tin) < 0.3 && Math.abs(b.outT - tout) < 0.3, 'trim drag');
    await page.screenshot({ path: `screenshots/${tag}-${k}-timeline.png`, clip: { x: 0, y: box.y - 60, width: 1500, height: box.height + 120 } });
    // keyboard
    await page.keyboard.press('Space'); await page.waitForTimeout(600); await page.keyboard.press('Space');
    const runs = [{ name: 'theater', layout: 'theater', hud: true, off: [] }, { name: 'grid', layout: 'grid', hud: true, off: [] }];
    if (s.mode === 'driving') runs.push({ name: 'nohud', layout: 'theater', hud: false, off: [] }, { name: 'nospeed', layout: 'theater', hud: true, off: ['speed', 'gforce'] });
    else runs.push({ name: 'nohud', layout: 'grid', hud: false, off: [] }, { name: 'noclock', layout: 'grid', hud: true, off: ['clock'] });
    for (const r of runs) {
      const live = await page.evaluate(() => window.__teslacam.opts);
      await page.click('#export');
      await page.selectOption('#xLayout', r.layout); await page.selectOption('#xRes', '1280x720');
      await page.check(r.hud ? '#xHudOn' : '#xHudOff');
      for (const cb of await page.$$('#xItems input')) await cb.setChecked(!r.off.includes(await cb.getAttribute('data-k')));
      if (r.name === 'theater') await page.locator('#exportDlg').screenshot({ path: `screenshots/${tag}-${k}-export-dialog.png` });
      console.log(`     dialog summary: ${await page.textContent('#xSummary')}`);
      const dl = page.waitForEvent('download', { timeout: 180000 });
      await page.click('#xGo');
      const res = await Promise.race([dl, page.waitForSelector('#err', { state: 'visible', timeout: 180000 }).then(() => null)]);
      if (!res) throw new Error('export error: ' + await page.evaluate(() => window.__lastError));
      const path = `/workspace/export-${tag}-${k}-${r.name}.mp4`; await res.saveAs(path);
      const live2 = await page.evaluate(() => window.__teslacam.opts);
      assert(JSON.stringify(live) === JSON.stringify(live2), 'export toggles changed live overlay');
      console.log(`     export ${r.name} trimmed ${b.inT.toFixed(2)}–${b.outT.toFixed(2)}:`, await page.evaluate(() => ({ size: window.__lastExport.size, ms: Math.round(window.__lastExport.ms) })), path);
    }
  }
  clearInterval(watch);
  console.log('loading overlay seen:', sawBusy);
} catch (e) { ok = false; console.error('FAIL', e); }
console.log('console errors:', errors);
await browser.close(); srv.kill();
process.exit(ok && !errors.length ? 0 : 1);
