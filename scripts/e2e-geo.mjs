// Tests the local helper (/geo) wiring + client fallback, and click-to-expand cameras.
// Never uses a real LocationIQ key: runs (a) no key, (b) dummy key against real LocationIQ (expects 401/403),
// (c) dummy key against a local mock upstream to check names, caching and the toggle.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import http from 'http';
import { rmSync } from 'fs'; rmSync('/tmp/tcc-geo-test-cache.json', { force: true });
const folder = process.argv[2] || '../test-footage';
const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); console.log('  ok:', m); };
let mockHits = 0;
const mock = http.createServer((q, r) => { mockHits++; const u = new URL(q.url, 'http://x'); r.setHeader('content-type', 'application/json');
  r.end(JSON.stringify({ address: { road: `Mock Rd ${u.searchParams.get('lat').slice(0, 6)}`, city: 'Testville' } })); }).listen(8999, '127.0.0.1');
async function withServer(env, fn) {
  const p = spawn('python3', ['server/teslacutcam-server.py'], { stdio: 'inherit', env: { ...process.env, TCC_SITE: 'dist', TCC_STRICT_PORT: '1', TCC_GEO_CACHE: '/tmp/tcc-geo-test-cache.json', TESLACAM_GEO_KEY: '', ...env } });
  await new Promise(r => setTimeout(r, 800));
  try { await fn(); } finally { p.kill(); await new Promise(r => setTimeout(r, 300)); }
}
const browser = await chromium.launch();
let ok = true;
async function open(k = 1) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', e => { ok = false; console.log('pageerror', e); });
  await page.goto('http://localhost:8123/');
  await page.setInputFiles('#dirInput', folder); await page.waitForSelector('.ev');
  await page.click(`.ev >> nth=${k}`); await page.waitForTimeout(100); await page.waitForSelector('#busy', { state: 'hidden' }); await page.waitForTimeout(800);
  return page;
}
const st = p => p.evaluate(() => window.__teslacam.state);
try {
  // bind check
  await withServer({}, async () => {
    const r = await fetch('http://127.0.0.1:8123/geo/status').then(r => r.json());
    assert(r.helper && !r.key, 'no key → helper reports key:false');
    const bad = await fetch('http://127.0.0.1:8123/geo?lat=abc&lon=1'); assert(bad.status === 400, 'bad coords → 400');
    const nk = await fetch('http://127.0.0.1:8123/geo?lat=35.2&lon=-81.3'); assert(nk.status === 503, 'no key → /geo 503');
    const page = await open(1);
    const s = await st(page); assert(s.place === 'I-85 S, Bessemer City', `fallback to event.json street/city ("${s.place}")`);
    await page.click('#settingsBtn'); await page.waitForTimeout(200);
    assert(await page.isDisabled('#streets'), 'street toggle disabled without key: ' + await page.textContent('#geoStatus'));
    await page.locator('#settings').screenshot({ path: 'screenshots/geo-settings-nokey.png' });
    await page.keyboard.press('Escape');
    // ---- expand tests ----
    const box = await page.locator('#screen').boundingBox();
    for (const [lay, fx, fy, want] of [['theater', 0.25, 0.42, 'left_pillar'], ['theater', 0.75, 0.6, 'right_repeater'], ['theater', 0.5, 0.85, 'back'], ['grid', 0.1, 0.1, null], ['pip', 0.5, 0.5, null], ['single', 0.5, 0.5, null]]) {
      await page.selectOption('#layout', lay); await page.waitForTimeout(300);
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(300);
      const e = (await st(page)).expanded; assert(e && (!want || e === want), `${lay}: click expands ${e}`);
      if (lay === 'theater' && want === 'left_pillar') {
        await page.screenshot({ path: 'screenshots/expanded-left-pillar.png' });
        await page.click('#play'); await page.waitForTimeout(1000); await page.click('#play');
        assert((await st(page)).expanded === 'left_pillar', 'stays expanded during playback');
        await page.keyboard.press('Escape'); await page.waitForTimeout(200);
        const s2 = await st(page); assert(!s2.expanded && s2.layout === 'theater', 'Esc restores theater');
        continue;
      }
      if (lay === 'theater' && want === 'back') { await page.click('#expChip'); assert(!(await st(page)).expanded, 'chip collapses'); continue; }
      if (lay === 'theater') { await page.click('#collapse'); assert(!(await st(page)).expanded, 'back button collapses'); continue; }
      await page.waitForTimeout(500); await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.waitForTimeout(200);
      assert(!(await st(page)).expanded && (await st(page)).layout === lay, `${lay}: double-click restores`);
    }
    // front expanded with HUD on (overlay check)
    await page.selectOption('#layout', 'theater'); await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.1); await page.waitForTimeout(400);
    await page.screenshot({ path: 'screenshots/expanded-front-hud.png' });
    assert((await st(page)).expanded === 'front', 'front expands');
    await page.close();
  });
  await withServer({ TESLACAM_GEO_KEY: 'dummy-not-a-real-key' }, async () => {
    const r = await fetch('http://127.0.0.1:8123/geo?lat=35.29&lon=-81.29');
    const j = await r.json(); assert([401, 403].includes(r.status), `dummy key vs real LocationIQ → ${r.status} ${JSON.stringify(j)}`);
    const page = await open(1); await page.waitForTimeout(1500);
    const s = await st(page); assert(s.place === 'I-85 S, Bessemer City' && !s.geo.key, `client falls back after ${r.status} ("${s.place}")`);
    await page.close();
  });
  await withServer({ TESLACAM_GEO_KEY: 'dummy-mock', TESLACAM_GEO_UPSTREAM: 'http://127.0.0.1:8999/reverse' }, async () => {
    const page = await open(1);
    await page.click('#play'); await page.waitForTimeout(2500); await page.click('#play');
    const s = await st(page); assert(s.place.startsWith('Mock Rd'), `street name from helper ("${s.place}")`);
    const hits = mockHits;
    const again = await fetch('http://127.0.0.1:8123/geo?lat=35.29&lon=-81.29').then(r => r.json());
    await fetch('http://127.0.0.1:8123/geo?lat=35.2901&lon=-81.2899').then(r => r.json()).then(j => assert(j.cached, 'server cache hit on ~100 m grid'));
    assert(mockHits === hits + 1, 'only one upstream call for repeat lookups');
    await page.click('#settingsBtn'); await page.waitForTimeout(200);
    await page.locator('#settings').screenshot({ path: 'screenshots/geo-settings-on.png' });
    await page.uncheck('#streets'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert((await st(page)).place === 'I-85 S, Bessemer City', 'toggle off → event.json fallback');
    await page.screenshot({ path: 'screenshots/geo-toggle-off.png' });
    await page.close();
  });
} catch (e) { ok = false; console.error('FAIL', e); }
await browser.close(); mock.close();
process.exit(ok ? 0 : 1);
