// Long multi-segment chunked export into ONE fragmented MP4: Auto plan vs simulated 1 GB RAM + Low memory.
import { chromium } from 'playwright';
import { startServer, assert, watch, openFolder, openEvent, exportTo, probe, savePng } from './lib.mjs';
const FOLDER = process.argv[2] || '../test-long', OUT = '/workspace/feat';
const srv = await startServer(); const browser = await chromium.launch(); const errors = []; let ok = true;
try {
  const results = {};
  for (const [name, q, perf] of [['auto', '', 'auto'], ['lowmem', '?ram=1', 'low']]) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    await ctx.addInitScript(p => localStorage.setItem('tcc.features', JSON.stringify({ perf: p })), perf);
    const page = await ctx.newPage(); watch(page, errors);
    await page.goto('http://localhost:8123/' + q); await openFolder(page, FOLDER);
    await openEvent(page, '');
    const s = await page.evaluate(() => window.__teslacutcam.state);
    await page.click('#settingsBtn'); await page.waitForTimeout(300);
    console.log(`[${name}] total ${s.total.toFixed(1)} s · ${await page.textContent('#memInfo')}`);
    await page.locator('#settings').screenshot({ path: `screenshots/r4-memory-${name}.png` }); await page.keyboard.press('Escape');
    const t0 = Date.now();
    const r = await exportTo(page, `${OUT}/long-${name}.mp4`, async p => { await p.selectOption('#xLayout', 'grid'); await p.selectOption('#xRes', '1280x720'); });
    const pr = probe(`${OUT}/long-${name}.mp4`);
    console.log(`[${name}] ${Math.round((Date.now() - t0) / 1000)} s wall · plan: ${r.plan.note} · chunks ${r.chunks} · peak resident input ${(r.mem.peakResident / 2 ** 20).toFixed(1)} MB · loads ${r.mem.loads} · probe`, pr);
    assert(pr.mono && pr.decodeErrors === 0, `${name}: one MP4, strictly increasing DTS, decodes cleanly`);
    assert(Math.abs(pr.dur - s.total) < 1, `${name}: duration ${pr.dur.toFixed(1)} ≈ source ${s.total.toFixed(1)} across 3 segments`);
    assert(r.chunks > 3, `${name}: exported in ${r.chunks} chunks`);
    savePng(`${OUT}/long-${name}.mp4`, 100, `screenshots/r4-long-${name}-100s.png`);
    results[name] = r; await ctx.close();
  }
  assert(results.lowmem.plan.chunkSec < results.auto.plan.chunkSec || results.lowmem.plan.queue < results.auto.plan.queue, `low-memory plan is smaller (${results.lowmem.plan.chunkSec}s/q${results.lowmem.plan.queue} vs ${results.auto.plan.chunkSec}s/q${results.auto.plan.queue})`);
  assert(results.lowmem.mem.peakResident <= results.auto.mem.peakResident, 'low-memory run keeps less input in memory');
} catch (e) { ok = false; console.error('FAIL', e); }
console.log('console errors:', errors);
await browser.close(); srv.kill(); process.exit(ok && !errors.length ? 0 : 1);
