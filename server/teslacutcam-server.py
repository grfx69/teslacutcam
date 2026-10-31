"""Tesla Cut Cam Export helper (Python standard library only).

Two modes:
  portable (default)  serves the built site and the same-origin /geo reverse-geocoding proxy on
                      127.0.0.1, using port 8123 or the next free port; opens the browser.
  web (--web)         /geo proxy only, for the hosted site behind nginx + Cloudflare Tunnel.
                      Listens on 127.0.0.1:8125, rate limits per client IP (CF-Connecting-IP).

The LocationIQ key never reaches the browser. It is read from (first match wins):
  env TCC_GEO_KEY, env TESLACAM_GEO_KEY, the file named by TCC_GEO_KEY_FILE,
  teslacutcam-geo.key or teslacam-geo.key next to this script.
Other env vars: TCC_PORT (or TESLACAM_PORT), TCC_SITE (or TESLACAM_SITE), TCC_GEO_UPSTREAM,
TCC_GEO_CACHE (cache file), TCC_OPEN=1 (or TESLACAM_OPEN=1) to open the browser,
TCC_RATE_PER_MIN (web mode per-IP limit, default 30), TCC_STRICT_PORT=1 to fail instead of moving port.
"""
import json, os, socket, sys, threading, time, urllib.parse, urllib.request, urllib.error
from collections import OrderedDict, deque
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

def env(*names, default=''):
    for n in names:
        v = os.environ.get(n)
        if v: return v
    return default

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = '--web' in sys.argv or env('TCC_MODE') == 'web'
SITE = env('TCC_SITE', 'TESLACAM_SITE', default=os.path.join(HERE, 'site'))
KEY_FILES = [p for p in (env('TCC_GEO_KEY_FILE'), os.path.join(HERE, 'teslacutcam-geo.key'), os.path.join(HERE, 'teslacam-geo.key')) if p]
CACHE_FILE = env('TCC_GEO_CACHE', default=os.path.join(HERE, 'teslacutcam-geo-cache.json'))
UPSTREAM = env('TCC_GEO_UPSTREAM', 'TESLACAM_GEO_UPSTREAM', default='https://us1.locationiq.com/v1/reverse')
PORT = int(env('TCC_PORT', 'TESLACAM_PORT', default='8125' if WEB else '8123'))
RATE_PER_MIN = int(env('TCC_RATE_PER_MIN', default='30'))
CACHE_MAX = 50000

def read_key():
    k = env('TCC_GEO_KEY', 'TESLACAM_GEO_KEY').strip()
    for p in KEY_FILES:
        if k: break
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f: k = f.read().strip()
    return k

try:
    with open(CACHE_FILE, encoding='utf-8') as f: CACHE = OrderedDict(json.load(f))
except Exception:
    CACHE = OrderedDict()
lock = threading.Lock()
last_call = [0.0]; backoff_until = [0.0]; dirty = [0]

def save_cache(force=False):
    dirty[0] += 1
    if not force and dirty[0] % 10: return
    tmp = CACHE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(CACHE, f)
    os.replace(tmp, CACHE_FILE)

def lookup(lat, lon):
    """Returns (http_status, payload). Results cached on a ~100 m grid, in memory and on disk."""
    ck = f'{lat:.3f},{lon:.3f}'
    if ck in CACHE: CACHE.move_to_end(ck); return 200, {'name': CACHE[ck], 'cached': True}
    key = read_key()
    if not key: return 503, {'error': 'no_key'}
    with lock:  # serialise upstream calls and respect the free-tier rate (2 req/s)
        if ck in CACHE: return 200, {'name': CACHE[ck], 'cached': True}
        if time.time() < backoff_until[0]: return 429, {'error': 'rate_limited', 'retry_in': round(backoff_until[0] - time.time(), 1)}
        wait = 0.6 - (time.time() - last_call[0])
        if wait > 0: time.sleep(wait)
        last_call[0] = time.time()
        q = urllib.parse.urlencode({'key': key, 'lat': f'{lat:.6f}', 'lon': f'{lon:.6f}', 'format': 'json', 'zoom': 17})
        try:
            with urllib.request.urlopen(urllib.request.Request(f'{UPSTREAM}?{q}', headers={'User-Agent': 'TeslaCutCam/1.0'}), timeout=8) as r:
                j = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429: backoff_until[0] = time.time() + 30
            return (e.code if e.code in (401, 403, 404, 429) else 502), {'error': 'upstream', 'status': e.code}
        except Exception as e:
            backoff_until[0] = time.time() + 10
            return 502, {'error': 'network', 'detail': type(e).__name__}
        a = j.get('address', {})
        road = a.get('road') or a.get('pedestrian') or a.get('highway') or a.get('name') or ''
        city = a.get('city') or a.get('town') or a.get('village') or a.get('hamlet') or a.get('suburb') or ''
        name = ', '.join(x for x in (road, city) if x) or j.get('display_name', '')
        CACHE[ck] = name
        while len(CACHE) > CACHE_MAX: CACHE.popitem(last=False)
        try: save_cache(force=not WEB)
        except Exception: pass
        return 200, {'name': name, 'cached': False}

hits = {}; hits_lock = threading.Lock()
def allowed(ip):
    """sliding one-minute window per client IP (web mode only)"""
    now = time.time()
    with hits_lock:
        q = hits.setdefault(ip, deque())
        while q and now - q[0] > 60: q.popleft()
        if len(q) >= RATE_PER_MIN: return False
        q.append(now)
        if len(hits) > 10000:
            for k in [k for k, v in hits.items() if not v or now - v[-1] > 60]: del hits[k]
        return True

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=SITE, **kw)
    def log_message(self, fmt, *args): pass  # keep the console quiet (and coordinates out of logs)
    def send_json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def client_ip(self):
        # we only listen on 127.0.0.1, so these headers come from nginx / cloudflared
        h = self.headers
        return h.get('CF-Connecting-IP') or (h.get('X-Forwarded-For') or '').split(',')[0].strip() or self.client_address[0]
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/geo/status':
            return self.send_json(200, {'helper': True, 'key': bool(read_key()), 'cached': len(CACHE), 'mode': 'web' if WEB else 'portable'})
        if u.path == '/geo':
            if WEB and not allowed(self.client_ip()): return self.send_json(429, {'error': 'rate_limited', 'retry_in': 60})
            q = urllib.parse.parse_qs(u.query)
            try:
                lat, lon = float(q['lat'][0]), float(q['lon'][0])
                assert -90 <= lat <= 90 and -180 <= lon <= 180
            except Exception:
                return self.send_json(400, {'error': 'bad_coords'})
            code, obj = lookup(lat, lon)
            return self.send_json(code, obj)
        if WEB: return self.send_json(404, {'error': 'not_found'})
        return super().do_GET()

def bind(port):
    strict = env('TCC_STRICT_PORT') == '1' or WEB
    for p in ([port] if strict else range(port, port + 30)):
        try: return ThreadingHTTPServer(('127.0.0.1', p), Handler), p
        except OSError: continue
    raise SystemExit(f'No free port found starting at {port}. Close other copies of Tesla Cut Cam Export and try again.')

if __name__ == '__main__':
    srv, port = bind(PORT)
    key = 'on - key found' if read_key() else 'off - no key'
    if WEB:
        print(f'Tesla Cut Cam /geo proxy (web mode) on http://127.0.0.1:{port}/geo  street names: {key}; limit {RATE_PER_MIN}/min per IP', flush=True)
    else:
        if not os.path.exists(os.path.join(SITE, 'index.html')): print(f'WARNING: site folder not found: {SITE}', flush=True)
        print(f'Tesla Cut Cam Export running at http://localhost:{port}/  (street names: {key})', flush=True)
        if port != PORT: print(f'(port {PORT} was busy, using {port})', flush=True)
        print('Close this window to stop.', flush=True)
        if env('TCC_OPEN', 'TESLACAM_OPEN') == '1':
            import webbrowser; webbrowser.open(f'http://localhost:{port}/')
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        try: save_cache(force=True)
        except Exception: pass
