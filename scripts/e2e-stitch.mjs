import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:8123/'; if (!process.argv[2]) await startServer();
const dir = process.env.DIR || '/workspace/test-footage';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; await p.route(/arcgisonline/, r => r.abort()); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(url); await openFolder(p, dir);
await p.click('.ev >> nth=' + (process.env.EV ?? 1)); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.waitForTimeout(1500);
await p.evaluate(() => window.teslacam?.seek?.(20)).catch(() => {}); await p.waitForTimeout(800);
const want = { front: 'Front', back: 'Rear', left_pillar: 'Left pillar', right_pillar: 'Right pillar', left_repeater: 'Left repeater', right_repeater: 'Right repeater' };
let bad = 0;
for (const l of ['stitch', 'pano', 'panorear']) {
  await p.selectOption('#layout', l); await p.waitForTimeout(500);
  for (const m of l === 'pano' ? [1] : [1, 0]) {
    if (l !== 'pano') { const cb = p.locator('#rearMirror'); if ((await cb.isChecked()) !== !!m) await cb.click(); await p.waitForTimeout(400); }
    await p.locator('#screen').screenshot({ path: `/workspace/st-${l}${l === 'pano' ? '' : m ? '-mir' : '-nomir'}.png` });
  }
  const t0 = Date.now(); const fr = await p.evaluate(() => new Promise(r => { let n = 0; const s = performance.now(); const f = () => (++n < 30 ? requestAnimationFrame(f) : r(30000 / (performance.now() - s))); requestAnimationFrame(f); }));
  const lp = await p.evaluate(() => window.__lastPlan);
  for (const c of lp.cells) {
    const box = await p.locator('#screen').boundingBox();
    // click the visible centre of the cell (avoid the overlap band shared with the previous neighbour)
    await p.mouse.click(box.x + (c.r[0] + c.r[2] * 0.6) / lp.W * box.width, box.y + (c.r[1] + c.r[3] * 0.6) / lp.H * box.height);
    await p.waitForTimeout(200); const got = await p.textContent('#expChip span');
    console.log(l, c.cam, '->', got, got === want[c.cam] ? 'OK' : 'WRONG'); if (got !== want[c.cam]) bad++;
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  }
  console.log(l, 'raf fps ~', fr.toFixed(0), Date.now() - t0);
}
console.log('bad', bad, 'errors', errs);
await b.close(); process.exit(0);
