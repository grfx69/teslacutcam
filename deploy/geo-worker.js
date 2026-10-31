// Cloudflare Worker alternative to the Python /geo helper.
// Route: teslacutcam.wackedoodle.com/geo*  (everything else stays on the static site / tunnel).
// Secrets/bindings:  wrangler secret put LOCATIONIQ_KEY
//                    KV namespace bound as GEO_CACHE (optional, for a shared cache)
//                    RATE_PER_MIN (optional var, default 30)
// Also runs on Node 18+ for local testing:  LOCATIONIQ_KEY=dummy node geo-worker.js  (listens on 127.0.0.1:8125)
const UPSTREAM = 'https://us1.locationiq.com/v1/reverse';
const hits = new Map(); // per-isolate sliding window; good enough to stop abuse
const mem = new Map();

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function allowed(ip, limit) {
  const now = Date.now(), q = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (q.length >= limit) { hits.set(ip, q); return false; }
  q.push(now); hits.set(ip, q);
  if (hits.size > 10000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return true;
}

async function handle(request, env) {
  const url = new URL(request.url), key = env.LOCATIONIQ_KEY || '';
  if (url.pathname === '/geo/status') return json(200, { helper: true, key: !!key, mode: 'worker' });
  if (url.pathname !== '/geo') return json(404, { error: 'not_found' });
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (!allowed(ip, +(env.RATE_PER_MIN || 30))) return json(429, { error: 'rate_limited', retry_in: 60 });
  const lat = +url.searchParams.get('lat'), lon = +url.searchParams.get('lon');
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !url.searchParams.get('lat')) return json(400, { error: 'bad_coords' });
  const ck = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (mem.has(ck)) return json(200, { name: mem.get(ck), cached: true });
  if (env.GEO_CACHE) { const v = await env.GEO_CACHE.get(ck); if (v !== null) { mem.set(ck, v); return json(200, { name: v, cached: true }); } }
  if (!key) return json(503, { error: 'no_key' });
  const q = new URLSearchParams({ key, lat: lat.toFixed(6), lon: lon.toFixed(6), format: 'json', zoom: '17' });
  let r;
  try { r = await fetch(`${env.UPSTREAM || UPSTREAM}?${q}`, { headers: { 'user-agent': 'TeslaCutCam/1.0' } }); }
  catch (e) { return json(502, { error: 'network' }); }
  if (!r.ok) return json([401, 403, 404, 429].includes(r.status) ? r.status : 502, { error: 'upstream', status: r.status });
  const j = await r.json(), a = j.address || {};
  const road = a.road || a.pedestrian || a.highway || a.name || '', city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
  const name = [road, city].filter(Boolean).join(', ') || j.display_name || '';
  mem.set(ck, name); if (mem.size > 20000) mem.delete(mem.keys().next().value);
  if (env.GEO_CACHE) await env.GEO_CACHE.put(ck, name, { expirationTtl: 60 * 60 * 24 * 180 });
  return json(200, { name, cached: false });
}

export default { fetch: (req, env) => handle(req, env) };

// Node entry point (local testing only)
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('geo-worker.js')) {
  const http = await import('node:http');
  const env = { LOCATIONIQ_KEY: process.env.LOCATIONIQ_KEY, UPSTREAM: process.env.TCC_GEO_UPSTREAM, RATE_PER_MIN: process.env.TCC_RATE_PER_MIN };
  const port = +(process.env.TCC_PORT || 8125);
  http.createServer(async (req, res) => {
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, String(v));
    const out = await handle(new Request(`http://127.0.0.1:${port}${req.url}`, { headers }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(await out.text());
  }).listen(port, '127.0.0.1', () => console.log(`geo-worker (node) on http://127.0.0.1:${port}/geo`));
}
