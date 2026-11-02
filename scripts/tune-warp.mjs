import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { openFolder, startServer } from './lib.mjs';
await startServer();
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
await p.route(/arcgisonline/, r => r.abort());
await p.goto(process.env.URL || 'http://localhost:8123/'); await openFolder(p, '/workspace/tf3');
await p.click('.ev >> nth=0'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('teslacam.overlay') || '{}'); }); 
await p.uncheck('#hud').catch(() => {});
const variants = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const L = process.env.L || 'pano';
await p.selectOption('#layout', L);
for (const [name, v] of Object.entries(variants)) {
  await p.evaluate(() => window.__teslacam.resetStitch());
  await p.evaluate(v => { for (const [c, x] of Object.entries(v)) window.__teslacam.setStitch(c, x); }, v);
  for (const t of (process.env.T || '20').split(',')) { await p.evaluate(t => window.__teslacam.seek(+t), t); await p.waitForTimeout(900);
    await p.locator('#screen').screenshot({ path: `/workspace/w-${name}-${L}-${t}.png` }); }
}
await b.close(); process.exit(0);
