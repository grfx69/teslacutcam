// Street names via the local TeslaCam helper (teslacam-server.py). The browser only ever calls the
// same-origin /geo endpoint; the LocationIQ key lives in teslacam-geo.key next to the launcher and
// never reaches the page. Results are cached in localStorage (and on disk by the helper).

export interface GeoStatus { helper: boolean; key: boolean; }
const LS = 'teslacam.geocache';
const cache = new Map<string, string>(Object.entries(JSON.parse(localStorage.getItem(LS) || '{}')));
let inflight = false, nextOk = 0, saveT = 0;
export let status: GeoStatus = { helper: false, key: false };

export async function checkGeo(): Promise<GeoStatus> {
  try { const r = await fetch('./geo/status', { cache: 'no-store' }); status = r.ok ? await r.json() : { helper: false, key: false }; }
  catch { status = { helper: false, key: false }; }
  return status;
}
export const geoEnabled = () => localStorage.getItem('teslacam.streets') !== 'off';
export const setGeoEnabled = (on: boolean) => localStorage.setItem('teslacam.streets', on ? 'on' : 'off');

/** Cached street name, or '' while a throttled lookup runs (callers fall back to event.json / coordinates). */
export function streetName(lat: number, lon: number): string {
  if (!status.key || !geoEnabled() || (!lat && !lon)) return '';
  const k = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const now = Date.now();
  if (!inflight && now >= nextOk) {
    inflight = true; nextOk = now + 700;
    fetch(`./geo?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (r.ok) { cache.set(k, j.name || ''); clearTimeout(saveT); saveT = window.setTimeout(() => localStorage.setItem(LS, JSON.stringify(Object.fromEntries(cache))), 500); }
      else if (r.status === 429) nextOk = Date.now() + 30000;
      else if (r.status === 401 || r.status === 403 || r.status === 503) { status = { ...status, key: false }; console.warn('[TeslaCam] street names disabled: helper says', r.status, j.error); }
      else nextOk = Date.now() + 10000;
    }).catch(() => { nextOk = Date.now() + 10000; }).finally(() => { inflight = false; });
  }
  return '';
}
