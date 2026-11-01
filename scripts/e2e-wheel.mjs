import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:8123/'; if (!process.argv[2]) await startServer();
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(url); await openFolder(p, '/workspace/test-footage');
const n = await p.locator('.ev').count(); console.log('events', n);
for (let k = 0; k < n; k++) {
  await p.click(`.ev >> nth=${k}`); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 }); await p.waitForTimeout(1200);
  await p.locator('#screen').screenshot({ path: `/workspace/wh-ev${k}.png` });
  if (k === 1) { const tb = await p.locator('#track').boundingBox();
    for (let j = 0; j < 12; j++) { await p.mouse.click(tb.x + tb.width * (0.03 + j * 0.08), tb.y + tb.height / 2); await p.waitForTimeout(700); await p.locator('#screen').screenshot({ path: `/workspace/wh-s${j}.png` }); } }
}
console.log('errors', errs); await b.close(); process.exit(0);
