import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
await startServer();
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await p.route(/arcgisonline/, r => r.abort());
p.on('console', m => { if (m.type() !== 'log') console.log('[pg]', m.text()); });
await p.goto(process.env.URL || 'http://localhost:8123/');
if (process.env.PINS) await p.evaluate(v => localStorage.setItem('tcc.pano3v1', v), process.env.PINS); else await p.evaluate(() => localStorage.removeItem('tcc.pano3v1'));
await p.reload(); await openFolder(p, process.env.DIR || '/workspace/tf3');
await p.click(`.ev >> nth=${process.env.EV || 0}`); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
await p.uncheck('#hud').catch(() => {});
await p.selectOption('#layout', process.env.L || 'pano3');
for (const t of (process.env.T || '20').split(',')) { await p.evaluate(t => window.__teslacam.seek(+t), t); await p.waitForTimeout(1200);
  await p.locator('#screen').screenshot({ path: `/workspace/p3-${process.env.TAG || 'a'}-${t}.png` }); }
console.log(await p.textContent('h1'));
await b.close(); process.exit(0);
