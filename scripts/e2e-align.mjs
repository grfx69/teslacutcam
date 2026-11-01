import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:8123/'; if (!process.argv[2]) await startServer();
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; await p.route(/arcgisonline/, r => r.abort()); p.on('pageerror', e => errs.push(e.message));
await p.goto(url); await openFolder(p, process.env.DIR || '/workspace/tf3');
await p.click('.ev >> nth=' + (process.env.EV ?? 0)); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.waitForTimeout(1500);
const T = (process.env.T || '8,20,35,50').split(',').map(Number);
const tag = process.env.TAG || 'x';
for (const l of (process.env.L || 'pano,stitch').split(',')) {
  await p.selectOption('#layout', l); await p.waitForTimeout(300);
  for (const t of T) {
    await p.evaluate(t => window.__teslacam.seek(t), t); await p.waitForTimeout(900);
    if (process.env.AUTO) { await p.evaluate(() => localStorage.removeItem('tcc.stitch3')); await p.reload(); await openFolder(p, process.env.DIR || '/workspace/tf3'); await p.click('.ev >> nth=0'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.selectOption('#layout', l); await p.evaluate(t => window.__teslacam.seek(t), t); await p.waitForTimeout(1200);
      await p.click('#alignBtn'); const msg = await p.evaluate(() => window.__teslacam.autoAlign()); 
      const r = await p.evaluate(() => Object.fromEntries(['left_pillar','left_repeater','right_pillar','right_repeater','back'].map(c => [c, window.__teslacam.stitch(c)])));
      console.log(l, t, msg, JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.dx, v.dy]])))); await p.click('#alClose'); await p.waitForTimeout(400); }
    await p.locator('#screen').screenshot({ path: `/workspace/al-${tag}-${l}-${t}.png` });
  }
}
console.log('errors', errs); await b.close(); process.exit(0);
