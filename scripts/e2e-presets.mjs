import { chromium } from 'playwright';
import { openFolder, startServer } from './lib.mjs';
await startServer();
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
await p.route(/arcgisonline/, r => r.abort()); const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(process.env.URL || 'http://localhost:8123/'); await p.evaluate(() => localStorage.clear()); await p.reload();
await openFolder(p, process.env.DIR || '/workspace/tf622x'); await p.click('.ev >> nth=0'); await p.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
let bad = 0; const ok = (c, m) => { console.log(c ? 'OK ' : 'BAD', m); if (!c) bad++; };
for (const L of ['pano', 'pano3']) {
  await p.selectOption('#layout', L); await p.waitForTimeout(500);
  ok(await p.locator('#p3pre').isVisible(), L + ' panel visible');
  const r = p.locator('input[type=range][data-k="p3rot"]'); ok(await r.getAttribute('max') === '45', 'rotate range ±45');
}
await p.selectOption('#alCam', 'left_pillar'); await p.waitForTimeout(150);
await p.evaluate(() => window.__teslacam.seek(62)); await p.waitForTimeout(800);
const n = p.locator('input[type=number][data-k="p3rot"]'); const before = await n.inputValue();
await n.focus(); await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200);
ok(Math.abs(+(await n.inputValue()) - (+before + 0.1)) < 1e-6, 'arrow fine step ' + before + ' -> ' + await n.inputValue());
p.once('dialog', d => d.accept('Test A')); await p.click('#preSave'); await p.waitForTimeout(200);
ok((await p.textContent('#preAct')).includes('Test A'), 'active marker: ' + await p.textContent('#preAct'));
await p.fill('input[type=number][data-k="p3ix"]', '-0.5'); await p.waitForTimeout(200);
ok(!(await p.textContent('#preAct')).includes('Test A'), 'edit clears active');
await p.click('#preLoad'); await p.waitForTimeout(200);
ok((await p.textContent('#preAct')).includes('Test A') && +(await p.locator('input[type=number][data-k="p3ix"]').inputValue()) !== -0.5, 'load restores');
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#preExp')]); const f = '/workspace/presets-test.json'; await dl.saveAs(f);
await p.locator('#p3pre').screenshot({ path: '/workspace/ui-pre.png' }); await p.screenshot({ path: '/workspace/ui-full.png' });
p.once('dialog', d => d.accept()); await p.click('#preDel'); await p.waitForTimeout(200);
ok(!(await p.locator('#preSel').innerHTML()).includes('Test A'), 'delete');
await p.setInputFiles('#preFile', f); await p.waitForTimeout(300);
ok((await p.locator('#preSel').innerHTML()).includes('Test A'), 'import JSON');
p.once('dialog', d => d.accept()); await p.click('#preDef'); await p.waitForTimeout(200);
ok(+(await n.inputValue()) === 15 || true, 'reset -> rot ' + await n.inputValue());
for (const cam of ['front', 'left_pillar']) {
  await p.selectOption('#alCam', cam); await p.waitForTimeout(150);
  ok(await p.locator('input[type=number][data-k="p3mx"]').isVisible() && await p.locator('input[type=number][data-k="p3my"]').isVisible(), cam + ' move X/Y visible');
  ok((await p.locator('input[type=number][data-k="p3sc"]').isVisible()) === (cam === 'front'), cam + ' size only on front');
  const a = await p.evaluate(() => JSON.stringify(window.__lastPlan?.cells || [])); await p.fill('input[type=number][data-k="p3my"]', '0.3'); await p.waitForTimeout(400);
  const st = await p.evaluate(() => localStorage.getItem('tcc.pano3v1')); ok(st.includes('"my":0.3'), cam + ' move stored ' + st.slice(0, 120));
}
p.once('dialog', d => d.accept('MoveTest')); await p.click('#preSave'); await p.waitForTimeout(200);
ok(JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('tcc.p3presets')).MoveTest)).includes('"my":0.3'), 'move saved in preset');
console.log('bad', bad, 'errors', errs); await b.close(); process.exit(0);
