import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:8123/'; if (!process.argv[2]) await startServer();
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = [], tiles = []; p.on('console', m => m.type() === 'error' && errs.push(m.text()));
p.on('response', r => { const u = r.url(); if (/tile|basemap|carto/i.test(u)) tiles.push([u.split('/')[2], r.status()]); });
for (const st of ['streets', 'dark', 'aerial', 'none']) for (const zm of ['close', 'medium', 'fit']) {
  await p.goto(url); await p.evaluate(([st, zm]) => { const o = JSON.parse(localStorage.getItem('teslacam.overlay') || '{}'); Object.assign(o, { map: true, mapStyle: st, mapZoom: zm }); localStorage.setItem('teslacam.overlay', JSON.stringify(o)); }, [st, zm]);
  await p.reload(); await openFolder(p, '/workspace/test-footage'); await p.click('.ev >> nth=1'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.waitForTimeout(4000);
  await p.locator('#screen').screenshot({ path: `/workspace/ms-${st}-${zm}.png` });
}
const hosts = {}; for (const [h, s] of tiles) hosts[h + ' ' + s] = (hosts[h + ' ' + s] || 0) + 1;
console.log('tile responses', hosts); console.log('errors', errs); await b.close(); process.exit(0);
