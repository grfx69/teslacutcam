// Firefox smoke test: folder load, events, playback, timeline, export (if WebCodecs is there) or the clear message.
import { firefox } from 'playwright';
import { startServer, assert, watch, openFolder, openEvent, exportTo, probe } from './lib.mjs';
const FOLDER = process.argv[2] || '../test-feat', PORT = 8130;
const srv = await startServer({ TCC_PORT: String(PORT) }); const errors = []; let ok = true;
const browser = await firefox.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true }); watch(page, errors);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(800);
  console.log('  browser:', await page.evaluate(() => navigator.userAgent), '| support:', JSON.stringify(await page.evaluate(() => window.__teslacutcam.support)));
  await openFolder(page, FOLDER);
  assert((await page.$$('.ev')).length === 3, 'Firefox: folder picker (webkitdirectory) lists 3 events');
  await openEvent(page, '8:35:44 PM');
  await page.click('#play'); await page.waitForTimeout(1500); await page.click('#play');
  const s = await page.evaluate(() => window.__teslacutcam.state);
  assert(s.cur > 0.5 && s.cams.length === 6, `Firefox: playback advanced to ${s.cur.toFixed(2)} s with ${s.cams.length} cameras`);
  await page.screenshot({ path: 'screenshots/r4-firefox-view.png' });
  const sup = await page.evaluate(() => window.__teslacutcam.support);
  if (sup?.ok) {
    const r = await exportTo(page, '/workspace/feat/firefox-export.mp4', async p => { await p.selectOption('#xLayout', 'grid'); await p.selectOption('#xRes', '1280x720'); });
    const pr = probe('/workspace/feat/firefox-export.mp4');
    assert(pr.mono && pr.decodeErrors === 0 && pr.frames > 100, `Firefox export valid (${pr.frames} frames, ${pr.dur.toFixed(1)} s)`);
  } else {
    assert(await page.isVisible('#unsupported'), 'Firefox: unsupported message shown: ' + await page.textContent('#unsupported'));
  }
} catch (e) { ok = false; console.error('FAIL', e); }
console.log('console errors:', errors);
await browser.close(); srv.kill(); process.exit(ok && !errors.length ? 0 : 1);
