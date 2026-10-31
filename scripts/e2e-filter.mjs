// Source filter test: TeslaCam root with RecentClips/SavedClips/SentryClips, plus single-event fallback.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
const root = process.argv[2] || '../root/TeslaCam', single = process.argv[3] || '../test-footage/SentryClips/2026-06-16_05-44-17';
const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); console.log('  ok:', m); };
const srv = spawn('python3', ['server/teslacutcam-server.py'], { stdio: 'ignore', env: { ...process.env, TCC_SITE: 'dist', TCC_STRICT_PORT: '1', TESLACAM_GEO_KEY: '' } });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch(), ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
let ok = true;
const page = await ctx.newPage(); page.on('pageerror', e => { ok = false; console.log('pageerror', e); });
const labels = () => page.$$eval('.ev small', els => els.map(e => e.textContent.split(' · ')[0]));
const ready = async () => { await page.waitForTimeout(150); await page.waitForSelector('#busy', { state: 'hidden' }); await page.waitForTimeout(300); };
try {
  await page.goto('http://localhost:8123/');
  await page.setInputFiles('#dirInput', root); await page.waitForSelector('.ev'); await ready();
  await page.click('#filterSum');
  const box = await page.textContent('#filterBox'); console.log('  filter:', box);
  assert(/All \(4\)/.test(box) && /Driving \(2\)/.test(box) && /Saved \(1\)/.test(box) && /Sentry \(1\)/.test(box), 'counts per folder');
  await page.uncheck('#filterBox input[data-c="Driving"]'); await ready();
  let l = await labels(); assert(l.length === 2 && l.includes('Saved') && l.includes('Sentry'), 'Saved + Sentry combination: ' + l);
  assert((await page.textContent('#filterSum')).includes('Saved (1) + Sentry (1)'), 'summary shows combination');
  await page.locator('#events').screenshot({ path: 'screenshots/filter-dropdown.png' });
  for (let k = 0; k < 2; k++) {
    await page.click(`.ev >> nth=${k}`); await ready();
    const s = await page.evaluate(() => window.__teslacam.state), c = (await labels())[k];
    assert(s.mode === (c === 'Sentry' ? 'sentry' : 'driving'), `${c} event → ${s.mode} overlay`);
  }
  await page.selectOption('#mode', 'driving'); assert((await page.evaluate(() => window.__teslacam.state)).mode === 'driving', 'manual override still works');
  await page.selectOption('#mode', 'auto');
  await page.uncheck('#filterBox input[data-c="Saved"]'); await ready();
  l = await labels(); assert(l.length === 1 && l[0] === 'Sentry', 'Sentry only');
  await page.reload(); await page.setInputFiles('#dirInput', root); await page.waitForSelector('.ev'); await ready();
  l = await labels(); assert(l.length === 1 && l[0] === 'Sentry', 'filter remembered after reload');
  await page.click('#filterSum'); await page.check('#filterBox input[data-c="all"]'); await ready();
  assert((await labels()).length === 4, 'All shows everything');
  await page.reload(); await page.setInputFiles('#dirInput', single); await page.waitForSelector('.ev'); await ready();
  l = await labels(); assert(l[0] === 'Sentry' && (await page.evaluate(() => window.__teslacam.state)).mode === 'sentry', 'single event folder classified Sentry from event.json');
} catch (e) { ok = false; console.error('FAIL', e); }
await browser.close(); srv.kill(); process.exit(ok ? 0 : 1);
