// Web-mode /geo proxy tests (dummy key + local mock upstream only): Python helper --web and the
// Cloudflare-Worker script under Node. Checks status, names, cache, rate limit per CF-Connecting-IP,
// bad input, no static files in web mode, and that the hosted page uses same-origin /geo.
import { spawn } from 'child_process';
import http from 'http';
import { chromium } from 'playwright';
const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); console.log('  ok:', m); };
let hits = 0;
const mock = http.createServer((q, r) => { hits++; const u = new URL(q.url, 'http://x'); assert(u.searchParams.get('key') === 'dummy-not-a-real-key', 'upstream got the dummy key only');
  r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ address: { road: 'Mock Rd', city: 'Testville' } })); }).listen(8999, '127.0.0.1');
const get = (port, path, ip = '1.1.1.1') => fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'CF-Connecting-IP': ip } }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
let ok = true;
async function suite(name, cmd, args, port) {
  console.log(`[${name}]`);
  const p = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, TCC_GEO_KEY: 'dummy-not-a-real-key', LOCATIONIQ_KEY: 'dummy-not-a-real-key', TCC_GEO_UPSTREAM: 'http://127.0.0.1:8999/', TCC_RATE_PER_MIN: '5', TCC_PORT: String(port), TCC_GEO_CACHE: `/tmp/tcc-web-${name}.json` } });
  await new Promise(r => setTimeout(r, 900));
  try {
    const st = await get(port, '/geo/status'); assert(st.s === 200 && st.j.key === true, 'status reports a key configured (dummy)');
    hits = 0;
    const a = await get(port, '/geo?lat=35.2596&lon=-81.2862'); assert(a.s === 200 && a.j.name === 'Mock Rd, Testville', 'street name via proxy');
    const b = await get(port, '/geo?lat=35.2597&lon=-81.2863'); assert(b.s === 200 && hits === 1, 'nearby lookup served from cache');
    const bad = await get(port, '/geo?lat=999&lon=0'); assert(bad.s === 400, 'bad coordinates rejected');
    const r = []; for (let i = 0; i < 4; i++) r.push((await get(port, '/geo?lat=35.26&lon=-81.28')).s);
    assert(r.includes(429), `rate limit 5/min per IP kicks in (${r.join(',')})`);
    const other = await get(port, '/geo?lat=35.26&lon=-81.28', '2.2.2.2'); assert(other.s === 200, 'other client IPs unaffected');
    const stat = await fetch(`http://127.0.0.1:${port}/index.html`); assert(stat.status === 404, 'web mode serves no static files (nginx does)');
  } finally { p.kill(); }
}
try {
  await suite('python', 'python3', ['server/teslacutcam-server.py', '--web'], 8125);
  await suite('worker-node', 'node', ['deploy/geo-worker.js'], 8126);
  // hosted page: static dist on one port with /geo on the same origin (portable helper stands in for nginx)
  const site = spawn('python3', ['server/teslacutcam-server.py'], { stdio: 'ignore', env: { ...process.env, TCC_SITE: 'dist', TCC_STRICT_PORT: '1', TCC_PORT: '8124', TCC_GEO_KEY: 'dummy-not-a-real-key', TCC_GEO_UPSTREAM: 'http://127.0.0.1:8999/', TCC_GEO_CACHE: '/tmp/tcc-web-site.json' } });
  await new Promise(r => setTimeout(r, 900));
  const b = await chromium.launch(); const pg = await b.newPage();
  const geoReqs = []; pg.on('request', q => { if (q.url().includes('/geo')) geoReqs.push(q.url()); });
  await pg.goto('http://localhost:8124/'); await pg.waitForTimeout(1200);
  assert(geoReqs.length && geoReqs.every(u => u.startsWith('http://localhost:8124/geo')), 'page talks to same-origin /geo only');
  await pg.click('#settingsBtn'); await pg.waitForTimeout(300);
  console.log('  settings text:', await pg.textContent('#geoStatus'));
  await pg.locator('#settings').screenshot({ path: 'screenshots/r4-web-geo-settings.png' });
  await b.close(); site.kill();
} catch (e) { ok = false; console.error('FAIL', e); }
mock.close(); process.exit(ok ? 0 : 1);
