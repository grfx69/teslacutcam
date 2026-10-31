import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:8123/'; if (!process.argv[2]) await startServer();
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; if (process.env.OFFLINE) await p.route(/arcgisonline|cartocdn|basemaps/, r => r.abort()); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(url); await openFolder(p, '/workspace/test-footage');
await p.click('.ev >> nth=1'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.waitForTimeout(1500);
let bad = 0;
for (const l of ['grid', 'pip']) for (const main of l === 'pip' ? ['front', 'back'] : ['front']) {
  await p.selectOption('#layout', l); if (l === 'pip') await p.selectOption('#cam', main);
  await p.waitForTimeout(400);
  const lp = await p.evaluate(() => window.__lastPlan); const cells = lp.cells;
  for (const c of cells) {
    const box = await p.locator('#screen').boundingBox(); const W = [lp.W, lp.H];
    await p.mouse.click(box.x + (c.r[0] + c.r[2] / 2) / W[0] * box.width, box.y + (c.r[1] + Math.min(c.r[3] / 2, 30)) / W[1] * box.height);
    await p.waitForTimeout(200); const got = await p.textContent('#expChip span');
    const want = { front: 'Front', back: 'Rear', left_pillar: 'Left pillar', right_pillar: 'Right pillar', left_repeater: 'Left repeater', right_repeater: 'Right repeater' }[c.cam];
    console.log(l, 'main=' + main, 'clicked slot', c.cam, '->', got, got === want ? 'OK' : 'WRONG'); if (got !== want) bad++;
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  }
}
// map
await p.selectOption('#layout', 'theater');
await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('teslacam.overlay') || '{}'); o.map = true; localStorage.setItem('teslacam.overlay', JSON.stringify(o)); });
await p.reload(); await openFolder(p, '/workspace/test-footage'); await p.click('.ev >> nth=1'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
await p.waitForTimeout(5000); await p.locator('#screen').screenshot({ path: '/workspace/t3-map' + (process.env.OFFLINE ? '-off' : '') + '.png' });
console.log('bad', bad, 'errors', errs);
await b.close(); process.exit(0);
