import './style.css';
import { buildLibrary, walkHandle, eventCams, camLabel, type Camera, type Entry, type TeslaEvent } from './library';
import type { Telemetry } from './sei';
import { setDefish, getDefish } from './defish';
import { p3Pins, setP3Pins, resetP3, p3Blend, setP3Blend, p3Presets, p3Active, savePreset, loadPreset, deletePreset, importPresets, exportPresets } from './pano3';
import { compose, plan, layoutAspect, type Layout, stitchPref, setStitchPref, resetStitch, autoAlign, stitchGroup } from './compose';
import { buildTrail, drawMapPanel, preloadTiles, setTileListener, type Trail } from './map';
import { defaultRamp, findTriggers, rateAt, TRIGGER_LABEL, type RampOpts, type Trigger } from './ramps';
import { defaultStab, type StabOpts } from './stab';
import { defaultTitle, defaultEnd, drawCard, FONTS, type CardOpts } from './cards';
import { planChunks, detectRam, type Perf } from './memory';
import { detectSupport, canDecode, type Support } from './support';
import { idbGet, idbSet } from './idb';
import { drawHud, drawSentryHud, defaultOverlay, type OverlayOpts, type Mode } from './overlay';
import { checkGeo, streetName, geoEnabled, setGeoEnabled, status as geoStatus } from './geo';
import { exportVideo, type Part } from './exporter';
import TelemetryWorker from './telemetry.worker?worker';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = $<HTMLCanvasElement>('screen'), ctx = screen.getContext('2d')!;
const track = $<HTMLCanvasElement>('track');
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------- state ----------
let events: TeslaEvent[] = [];
let ev: TeslaEvent | null = null;
let cams: Camera[] = [];
let tel: (Telemetry | null)[] = [];
let segStarts: number[] = [], total = 0;
let seg = -1, inT = 0, outT = Infinity, cur = 0;
let mode: Mode = 'driving';
const vids: Record<Camera, HTMLVideoElement> = {};
const opts: OverlayOpts = { ...defaultOverlay, ...JSON.parse(localStorage.getItem('teslacam.overlay') || '{}') };
let lastPlace = '';
let abort: AbortController | null = null;
let trail: Trail | null = null, triggers: Trigger[] = [];
// round-4 feature settings (all optional, off by default, persisted)
interface Features { ramp: RampOpts; stab: StabOpts; title: CardOpts; end: CardOpts; perf: Perf; remember: boolean; }
const saved = JSON.parse(localStorage.getItem('tcc.features') || '{}');
const F: Features = { ramp: { ...defaultRamp, ...saved.ramp }, stab: { ...defaultStab, ...saved.stab }, title: { ...defaultTitle, ...saved.title }, end: { ...defaultEnd, ...saved.end }, perf: saved.perf ?? 'auto', remember: saved.remember ?? false };
const saveF = () => localStorage.setItem('tcc.features', JSON.stringify(F));
let logo: ImageBitmap | null = null, logoName = '';
let support: Support | null = null;

// ---------- busy / error UI ----------
function busy(msg: string | null, p?: number) {
  document.body.classList.toggle('loading', msg !== null);
  $('busy').hidden = msg === null;
  if (msg !== null) {
    $('busyMsg').textContent = msg;
    const pr = $<HTMLProgressElement>('busyProg');
    if (p === undefined) pr.removeAttribute('value'); else pr.value = p;
  }
}
let errDetails = '';
function showError(title: string, err: unknown) {
  const e = err as Error;
  errDetails = `${title}\n${e?.name ?? ''}: ${e?.message ?? String(err)}\n${e?.stack ?? ''}\nBrowser: ${navigator.userAgent}\nEvent: ${ev?.id ?? '-'}\nCameras: ${cams.join(', ')}`;
  $('errMsg').textContent = `${title}: ${e?.message ?? String(err)}`;
  $('err').hidden = false;
  (window as any).__lastError = errDetails;
  console.warn('[TeslaCutCam]', errDetails);
}
$('errCopy').onclick = () => navigator.clipboard?.writeText(errDetails);
$('errClose').onclick = () => { $('err').hidden = true; };

// ---------- telemetry worker ----------
const worker = new TelemetryWorker();
let reqId = 0; const pending = new Map<number, (t: Telemetry | null) => void>();
worker.onmessage = e => { pending.get(e.data.id)?.(e.data.t ?? null); pending.delete(e.data.id); };
const parse = (file: File) => new Promise<Telemetry | null>(r => { const id = ++reqId; pending.set(id, r); worker.postMessage({ id, file }); });

// ---------- overlay toggles / type ----------
const LABELS: [keyof OverlayOpts, string][] = [['speed', 'Speed'], ['gear', 'Gear'], ['autopilot', 'FSD/Autopilot'], ['steering', 'Steering'], ['pedals', 'ACC/BRK'], ['gforce', 'G-force'], ['blinkers', 'Blinkers'], ['location', 'Location'], ['clock', 'Date/time'], ['compass', 'Heading'], ['map', 'Map']];
for (const [k, l] of LABELS) {
  const lab = document.createElement('label'); lab.dataset.k = k;
  lab.innerHTML = `<input type="checkbox" data-k="${k}" ${opts[k] ? 'checked' : ''}> ${l}`;
  $('toggles').append(lab);
}
$('toggles').addEventListener('change', e => {
  const i = e.target as HTMLInputElement; (opts as any)[i.dataset.k!] = i.checked;
  localStorage.setItem('teslacam.overlay', JSON.stringify(opts)); draw();
});
const modeSel = document.createElement('select');
modeSel.id = 'mode'; modeSel.innerHTML = '<option value="auto">Type: auto</option><option value="driving">Driving</option><option value="sentry">Sentry</option>';
$('layout').before(modeSel);
modeSel.onchange = () => { applyMode(); draw(); };
function applyMode() {
  const auto: Mode = ev && cat(ev) === 'Sentry' ? 'sentry' : 'driving';
  mode = modeSel.value === 'auto' ? auto : modeSel.value as Mode;
  $('toggles').querySelectorAll('label').forEach(l => (l as HTMLElement).hidden = mode === 'sentry' && !['location', 'clock', 'map'].includes(l.dataset.k!));
  modeSel.options[0].text = `Type: auto (${auto})`;
  const la = $<HTMLSelectElement>('layout');
  la.options[0].text = `Layout: auto (${autoLayout() === 'theater' ? 'all cameras' : 'grid'})`;
}
const autoLayout = (): Layout => mode === 'driving' && cams.length >= 3 ? 'theater' : cams.length > 1 ? 'grid' : 'single';
const layout = (): Layout => { const v = $<HTMLSelectElement>('layout').value; return v === 'auto' ? autoLayout() : v as Layout; };
const mainCam = () => $<HTMLSelectElement>('cam').value as Camera;
function size(): [number, number] {
  const W = +$<HTMLSelectElement>('res').value.split('x')[0];
  return [W, Math.round(W * layoutAspect(expanded ? 'single' : layout()) / 2) * 2];
}

// ---------- folder loading ----------
async function load(entries: Entry[]) {
  try {
    busy(`Found ${entries.length} files…`);
    events = await buildLibrary(entries, m => busy(m));
  } catch (e) { busy(null); return showError('Could not read that folder', e); }
  busy(null);
  renderList(true);
}
// ---------- source filter: Driving = RecentClips, Saved = SavedClips, Sentry = SentryClips ----------
type Cat = 'Driving' | 'Saved' | 'Sentry';
const CATS: Cat[] = ['Driving', 'Saved', 'Sentry'];
/** Category from the source folder; without standard folders, classify by what's in the event. */
function cat(e: TeslaEvent): Cat {
  if (e.kind === 'Sentry') return 'Sentry';
  if (e.kind === 'Saved') return 'Saved';
  if (e.kind === 'Recent') return 'Driving';
  if (e.info?.reason && /^sentry/i.test(e.info.reason)) return 'Sentry';
  return e.info ? 'Saved' : 'Driving';
}
let filter = new Set<Cat>(JSON.parse(localStorage.getItem('teslacam.filter') || '["Driving","Saved","Sentry"]'));
function renderFilter() {
  const n: Record<Cat, number> = { Driving: 0, Saved: 0, Sentry: 0 };
  events.forEach(e => n[cat(e)]++);
  const std = events.some(e => e.kind !== 'Clips');
  const shown = CATS.filter(c => filter.has(c));
  $('filterSum').textContent = shown.length === 3 ? `Show: All (${events.length})` : shown.length ? 'Show: ' + shown.map(c => `${c} (${n[c]})`).join(' + ') : 'Show: none';
  $('filterBox').innerHTML = `<label><input type="checkbox" data-c="all" ${shown.length === 3 ? 'checked' : ''}> All (${events.length})</label>` +
    CATS.map(c => `<label title="${{ Driving: 'RecentClips', Saved: 'SavedClips', Sentry: 'SentryClips' }[c]}"><input type="checkbox" data-c="${c}" ${filter.has(c) ? 'checked' : ''}> ${c} (${n[c]})${std ? ` <small>${{ Driving: 'RecentClips', Saved: 'SavedClips', Sentry: 'SentryClips' }[c]}</small>` : ''}</label>`).join('');
}
$('filterBox').addEventListener('change', e => {
  const i = e.target as HTMLInputElement, c = i.dataset.c!;
  if (c === 'all') filter = new Set(i.checked ? CATS : []); else i.checked ? filter.add(c as Cat) : filter.delete(c as Cat);
  localStorage.setItem('teslacam.filter', JSON.stringify([...filter]));
  renderList(false);
});
function renderList(openFirst: boolean) {
  renderFilter(); updateSheetBtn();
  const list = $('evList'); list.innerHTML = '';
  if (!events.length) { list.innerHTML = '<p class="hint">No Tesla clips found in that folder.</p>'; return; }
  const vis = events.filter(e => filter.has(cat(e)));
  if (!vis.length) { list.innerHTML = '<p class="hint">No events match this filter.</p>'; return; }
  for (const e of vis) {
    const d = document.createElement('div'); d.className = 'ev' + (e === ev ? ' sel' : '');
    const img = e.thumb ? `<img src="${URL.createObjectURL(e.thumb)}">` : '<img>';
    const where = e.info ? [e.info.street, e.info.city].filter(Boolean).join(', ') : '';
    d.innerHTML = `${img}<div><b>${e.name}</b><small>${cat(e)} · ${e.segments.length} clip${e.segments.length > 1 ? 's' : ''} · ${eventCams(e).length} cams${where ? ' · ' + where : ''}</small></div>`;
    d.onclick = () => { list.querySelectorAll('.ev').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); openEvent(e); };
    list.append(d);
  }
  if (openFirst || !ev || !vis.includes(ev)) (list.querySelector('.ev') as HTMLElement).click();
}
async function collect(dir: FileSystemDirectoryHandle, prefix = '') {
  const out: Entry[] = [];
  for await (const e of walkHandle(dir, prefix)) { out.push(e); if (out.length % 25 === 0) busy(`Scanning folder… ${out.length} files`); }
  return out;
}
$('pick').onclick = async () => {
  if (!('showDirectoryPicker' in window)) return $('dirInput').click();
  let dir: FileSystemDirectoryHandle;
  try { dir = await (window as any).showDirectoryPicker({ id: 'teslacam' }); } catch { return; }
  if (F.remember) { await idbSet('lastFolder', dir); lastFolderUI(); }
  busy('Scanning folder…');
  try { load(await collect(dir)); } catch (e) { busy(null); showError('Could not read that folder', e); }
};
$<HTMLInputElement>('dirInput').onchange = e => {
  const fs = [...(e.target as HTMLInputElement).files!];
  load(fs.map(f => ({ path: (f as any).webkitRelativePath || f.name, file: f })));
};
const view = $('view');
view.ondragover = e => { e.preventDefault(); view.classList.add('over'); };
view.ondragleave = () => view.classList.remove('over');
view.ondrop = async e => {
  e.preventDefault(); view.classList.remove('over');
  const out: Entry[] = [];
  busy('Scanning dropped folder…');
  for (const it of [...e.dataTransfer!.items]) {
    const h = await (it as any).getAsFileSystemHandle?.();
    if (h?.kind === 'directory') out.push(...await collect(h, h.name + '/'));
    else if (h?.kind === 'file') out.push({ path: h.name, file: await h.getFile() });
    else if (!h) { const en = (it as any).webkitGetAsEntry?.(); if (en) out.push(...await walkEntry(en, '')); } // Firefox / Safari
  }
  out.length ? load(out) : busy(null);
};

async function walkEntry(en: any, prefix: string): Promise<Entry[]> {
  if (en.isFile) return [{ path: prefix + en.name, file: await new Promise<File>((res, rej) => en.file(res, rej)) }];
  const rd = en.createReader(), out: Entry[] = [];
  for (;;) { const batch: any[] = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const b of batch) out.push(...await walkEntry(b, prefix + en.name + '/')); }
  return out;
}

// ---------- event / playback ----------
const clockFile = (i: number) => { const f = ev!.segments[i].files; return f.front ?? Object.values(f)[0]; };
async function openEvent(e: TeslaEvent) {
  pause(); if (expanded) setExpanded(null); ev = e; seg = -1; inT = 0; outT = Infinity; cur = 0;
  cams = eventCams(e);
  const camSel = $<HTMLSelectElement>('cam');
  camSel.innerHTML = cams.map(c => `<option value="${c}">${camLabel(c)}</option>`).join('');
  applyMode();
  if (mode === 'sentry' && e.info?.camera) {
    const m: Record<string, Camera> = { '5': 'left_repeater', '6': 'right_repeater', '7': 'back', '3': 'left_pillar', '4': 'right_pillar' };
    const c = m[e.info.camera]; if (c && cams.includes(c)) camSel.value = c;
  }
  $('cams').innerHTML = `Cameras found (${cams.length}): ` + cams.map(c => `<b>${camLabel(c)}</b>`).join(' · ') +
    (cams.includes('front_wide') ? '' : ' <span class="hint">(no front bumper camera in this footage)</span>');
  try {
    tel = []; let done = 0;
    busy(`Parsing telemetry… 0/${e.segments.length} clips`, 0);
    tel = await Promise.all(e.segments.map((_, i) => parse(clockFile(i)).then(t => {
      done++; busy(`Parsing telemetry… ${done}/${e.segments.length} clips`, done / e.segments.length); return t;
    })));
    segStarts = []; total = 0;
    tel.forEach(t => { segStarts.push(total); total += t?.duration || 60; });
    trail = buildTrail(tel, segStarts, e.info); computeTriggers(); if (opts.map) void preloadTiles(trail, opts, 8000);
    const f0 = clockFile(0); hevcCheck(f0);
    $('inT').textContent = '0:00'; $('outT').textContent = 'end';
    stats();
    busy(`Loading ${cams.length} camera videos…`);
    await seek(0);
    busy(null); drawTrack();
  } catch (err) { busy(null); showError('Could not open this event', err); }
}
function segAt(t: number) { let i = 0; while (i + 1 < segStarts.length && segStarts[i + 1] <= t) i++; return i; }
async function loadSeg(i: number) {
  seg = i;
  const files = ev!.segments[i].files;
  for (const v of Object.values(vids)) if (v.src) { v.pause(); v.removeAttribute('src'); v.load(); }
  let ready = 0; const list = Object.keys(files);
  await Promise.all(list.map(c => new Promise<void>(res => {
    let v = vids[c];
    if (!v) { v = vids[c] = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; }
    if (v.dataset.src) URL.revokeObjectURL(v.dataset.src);
    const done = () => { ready++; busyIf(`Decoding ${camLabel(c)}… (${ready}/${list.length} cameras ready)`, ready / list.length); res(); };
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', () => { console.warn('video error', c); done(); }, { once: true });
    v.src = v.dataset.src = URL.createObjectURL(files[c]);
  })));
}
function busyIf(m: string, p: number) { if (!$('busy').hidden) busy(m, p); }
const master = () => { const f = ev!.segments[seg].files; return vids[f.front ? 'front' : Object.keys(f)[0]]; };
async function seek(t: number) {
  if (!ev) return;
  t = Math.max(0, Math.min(total - 0.01, t)); cur = t;
  const i = segAt(t); if (i !== seg) await loadSeg(i);
  const local = t - segStarts[i];
  const ps: Promise<unknown>[] = [];
  for (const c of Object.keys(ev.segments[i].files)) {
    const v = vids[c]; if (!v?.src) continue;
    ps.push(new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); }));
    v.currentTime = local;
  }
  await Promise.all(ps);
  draw();
}
let playing = false;
function play() {
  if (!ev) return; playing = true; $('play').textContent = '❚❚';
  const rate = +$<HTMLSelectElement>('rate').value;
  for (const c of Object.keys(ev.segments[seg].files)) { const v = vids[c]; if (v?.src) { v.playbackRate = rate; v.play().catch(() => {}); } }
  loop();
}
function pause() { playing = false; $('play').textContent = '▶'; Object.values(vids).forEach(v => v.pause()); }
function now() { return ev && seg >= 0 ? segStarts[seg] + master().currentTime : 0; }
function loop() {
  if (!playing) return;
  const m = master(), t = now();
  for (const c of Object.keys(ev!.segments[seg].files)) { const v = vids[c]; if (v && v !== m && v.src && Math.abs(v.currentTime - m.currentTime) > 0.2) v.currentTime = m.currentTime; }
  if (t >= Math.min(outT, total) - 0.05 || m.ended) {
    if (seg + 1 < ev!.segments.length && t < outT - 0.1) { seek(segStarts[seg + 1]).then(() => playing && play()); return; }
    pause(); return;
  }
  draw();
  requestAnimationFrame(loop);
}
$('play').onclick = () => playing ? pause() : play();
$('rate').onchange = () => { if (playing) play(); };
['layout', 'cam', 'hud', 'res'].forEach(id => $(id).addEventListener('change', draw));
{ // rear mirror toggle for the stitched layouts
  const lab = document.createElement('label'); lab.id = 'mirrorWrap'; lab.title = 'Flip the rear camera like a rear-view mirror so its edges line up with the side cameras';
  lab.innerHTML = '<input type="checkbox" id="rearMirror"> Mirror rear';
  $('layout').after(lab);
  const cb = $<HTMLInputElement>('rearMirror'); cb.checked = localStorage.getItem('tcc.rearMirror') !== '0';
  const vis = () => { lab.hidden = !['stitch', 'panorear'].includes(layout()); };
  cb.addEventListener('change', () => { localStorage.setItem('tcc.rearMirror', cb.checked ? '1' : '0'); draw(); });
  $('layout').addEventListener('change', vis); vis();
  // stitch alignment panel
  const btn = document.createElement('button'); btn.id = 'alignBtn'; btn.textContent = 'Align seams…'; lab.after(btn);
  const pn = document.createElement('div'); pn.id = 'alignPanel'; pn.hidden = true;
  pn.style.cssText = 'position:fixed;right:16px;top:70px;z-index:50;background:#1b1d22;color:#ddd;border:1px solid #333;border-radius:8px;padding:10px 12px;font:13px system-ui;width:270px;box-shadow:0 6px 24px #0008';
  const sl = (k: string, t: string, mn: number, mx: number, st: number) => `<label style="display:flex;gap:6px;align-items:center;margin:4px 0">${t}<input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" style="flex:1"><span data-v="${k}" style="width:40px;text-align:right"></span></label>`;
  pn.innerHTML = `<b>Seam alignment</b> <button id="alClose" style="float:right">✕</button>
    <div style="margin:6px 0"><select id="alCam" style="width:100%"></select></div>
    ${sl('dx', 'Shift X', -0.2, 0.2, 0.002)}${sl('dy', 'Shift Y', -0.2, 0.2, 0.002)}${sl('z', 'Zoom', 1, 1.5, 0.01)}${sl('b', 'Blend', 0.25, 3, 0.05)}${sl('kl', 'Left edge height', 0.5, 2, 0.01)}${sl('kr', 'Right edge height', 0.5, 2, 0.01)}${sl('rot', 'Tilt °', -15, 15, 0.1)}${sl('p', 'Perspective', -0.8, 0.8, 0.01)}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button id="alAuto" title="Match edges in each overlap on the current frame and save the offsets">Auto-align</button><button id="alReset">Reset camera</button><button id="alResetAll">Reset all</button></div>
    <div id="alMsg" style="color:#9a9;margin-top:6px;min-height:1em"></div>`;
  document.body.append(pn);
  const camSel = $<HTMLSelectElement>('alCam');
  const fill = () => {
    camSel.innerHTML = cams.filter(c => !is3() || c.includes('pillar') || (layout() === 'pano' && c.includes('repeater'))).map(c => `<option value="${c}">${c.replace('_', ' ')}</option>`).join('');
    sync();
  };
  const P3K: [string, string, number, number][] = [['ix', 'Seam X', -2, 1.5], ['it', 'Seam top Y', -2, 2], ['ib', 'Seam bottom Y', -1, 3], ['ox', 'Outer X', -4, 0.5], ['ot', 'Outer top Y', -2.5, 2.5], ['ob', 'Outer bottom Y', -1, 4], ['rot', 'Rotate °', -45, 45], ['lens', 'Fisheye', -0.6, 0.8]];
  const p3get = (c: string) => { const p = p3Pins(c), L = c.startsWith('left'); const [i1, i2, o1, o2] = L ? [p.tr, p.br, p.tl, p.bl] : [p.tl, p.bl, p.tr, p.br];
    const f = (x: number) => L ? x : 1 - x; return { ix: f(i1[0]), it: i1[1], ib: i2[1], ox: f(o1[0]), ot: o1[1], ob: o2[1], lens: p.lens, rot: p.rot || 0 } as Record<string, number>; };
  const p3set = (c: string, v: Record<string, number>) => { const L = c.startsWith('left'), f = (x: number) => L ? x : 1 - x;
    const i1: [number, number] = [f(v.ix), v.it], i2: [number, number] = [f(v.ix), v.ib], o1: [number, number] = [f(v.ox), v.ot], o2: [number, number] = [f(v.ox), v.ob];
    setP3Pins(c, L ? { tr: i1, br: i2, tl: o1, bl: o2, lens: v.lens, rot: v.rot } : { tl: i1, bl: i2, tr: o1, br: o2, lens: v.lens, rot: v.rot }); };
  const sl3 = (k: string, t: string, mn: number, mx: number, st: number) => `<label style="display:flex;gap:6px;align-items:center;margin:3px 0"><span style="width:96px">${t}</span><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" style="flex:1"><input type="number" data-k="${k}" data-num="1" step="${st}" style="width:76px"></label>`;
  const p3html = () => `<div id="p3sl" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));column-gap:14px">${P3K.map(([k, t, a, b]) => sl3('p3' + k, t, a, b, k === 'rot' ? 0.1 : 0.002)).join('')}${sl3('p3fe', 'Blend width', 0, 0.3, 0.002)}</div>
    <div id="p3pre" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;border-top:1px solid #333;padding-top:6px">
      <b>View preset:</b> <select id="preSel" style="min-width:140px"></select> <span id="preAct" style="color:#8c8"></span>
      <button id="preSave" title="Save the current alignment as a named preset">💾 Save view…</button><button id="preLoad">Load</button><button id="preDel">Delete</button>
      <button id="preExp" title="Download all presets + current view as JSON">Export JSON</button><button id="preImp">Import JSON</button><input type="file" id="preFile" accept=".json,application/json" hidden>
      <button id="preDef" title="Back to the built-in default alignment">Reset to defaults</button></div>`;
  pn.querySelector('#alAuto')!.insertAdjacentHTML('beforebegin', '');
  pn.querySelector('select')!.parentElement!.insertAdjacentHTML('afterend', p3html());
  const is3 = () => layout() === 'pano3' || layout() === 'pano';
  const sync = () => { pn.querySelectorAll<HTMLElement>('label').forEach(l => { const k = l.querySelector('input')?.dataset.k || ''; l.style.display = (k.startsWith('p3') === is3()) ? 'flex' : 'none'; });
    ($('alAuto') as HTMLElement).hidden = is3(); $('p3pre').style.display = is3() ? 'flex' : 'none';
    if (is3()) { if (!/pillar|repeater/.test(camSel.value)) return; const v = p3get(camSel.value); v.fe = p3Blend(); for (const k of [...P3K.map(x => x[0]), 'fe']) pn.querySelectorAll<HTMLInputElement>(`[data-k="p3${k}"]`).forEach(i => { if (document.activeElement !== i) i.value = String(+v[k].toFixed(k === 'rot' ? 1 : 3)); }); preFill(); return; }
    const p = stitchPref(camSel.value, stitchGroup(layout())) as any; pn.querySelectorAll<HTMLInputElement>('input[data-k]').forEach(i => { if (i.dataset.k!.startsWith('p3')) return; i.value = p[i.dataset.k!]; pn.querySelector(`[data-v="${i.dataset.k}"]`)!.textContent = (+p[i.dataset.k!]).toFixed(2); }); };
  pn.addEventListener('input', e => { const i = e.target as HTMLInputElement; if (!i.dataset.k) return;
    if (i.dataset.k.startsWith('p3')) { if (i.value === '' || isNaN(+i.value)) return; const k = i.dataset.k.slice(2); if (k === 'fe') setP3Blend(+i.value); else { const v = p3get(camSel.value); v[k] = +i.value; p3set(camSel.value, v); } localStorage.removeItem('tcc.p3active'); sync(); draw(); return; } setStitchPref(camSel.value, { [i.dataset.k]: +i.value }, stitchGroup(layout())); sync(); draw(); });
  camSel.addEventListener('change', sync);
  btn.addEventListener('click', () => { pn.hidden = !pn.hidden; if (!pn.hidden) fill(); });
  $('alClose').addEventListener('click', e => { e.preventDefault(); pn.hidden = true; });
  $('alReset').addEventListener('click', () => { if (is3()) { setP3Pins(camSel.value, null); sync(); draw(); return; } setStitchPref(camSel.value, null, stitchGroup(layout())); sync(); draw(); });
  $('alResetAll').addEventListener('click', () => { if (is3()) resetP3(); else resetStitch(); sync(); draw(); });
  $('alAuto').addEventListener('click', () => {
    if (!ev || seg < 0) return;
    const src: Record<Camera, HTMLVideoElement> = {};
    for (const c of Object.keys(ev.segments[seg].files)) if (vids[c] && !vids[c].error) src[c] = vids[c];
    const t0 = performance.now(), r = autoAlign(layout(), src, cams);
    for (const [c, [dx, dy]] of Object.entries(r)) setStitchPref(c, { dx: +dx.toFixed(3), dy: +dy.toFixed(3) }, stitchGroup(layout()));
    $('alMsg').textContent = `Aligned ${Object.keys(r).length} seams in ${Math.round(performance.now() - t0)} ms`;
    sync(); draw();
  });
  function preFill() { const sel = $<HTMLSelectElement>('preSel'), names = Object.keys(p3Presets()), act = p3Active(), cur = sel.value;
    sel.innerHTML = names.length ? names.map(n => `<option${n === act ? ' selected' : ''}>${n.replace(/</g, '&lt;')}</option>`).join('') : '<option value="">(no presets)</option>';
    if (!act && names.includes(cur)) sel.value = cur; $('preAct').textContent = act ? `● active: ${act}` : '(unsaved changes / defaults)'; }
  const redraw3 = () => { fill(); draw(); };
  $('preSave').addEventListener('click', () => { const n = prompt('Name for this view preset:', p3Active() || 'My view'); if (n && n.trim()) { savePreset(n.trim()); redraw3(); } });
  $('preLoad').addEventListener('click', () => { const n = $<HTMLSelectElement>('preSel').value; if (n && loadPreset(n)) redraw3(); });
  $('preDel').addEventListener('click', () => { const n = $<HTMLSelectElement>('preSel').value; if (n && confirm(`Delete preset "${n}"?`)) { deletePreset(n); redraw3(); } });
  $('preSel').addEventListener('change', () => { const n = $<HTMLSelectElement>('preSel').value; if (n && loadPreset(n)) redraw3(); });
  $('preExp').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(exportPresets(), null, 2)], { type: 'application/json' })); a.download = 'teslacutcam-stitch-presets.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
  $('preImp').addEventListener('click', () => $('preFile').click());
  $('preFile').addEventListener('change', async () => { const f = $<HTMLInputElement>('preFile').files?.[0]; if (!f) return; try { importPresets(JSON.parse(await f.text())); redraw3(); } catch (e) { alert('Not a valid presets file: ' + e); } $<HTMLInputElement>('preFile').value = ''; });
  $('preDef').addEventListener('click', () => { if (confirm('Reset the stitched views to the built-in defaults? (saved presets are kept)')) { resetP3(); redraw3(); } });
  const FLOAT = pn.style.cssText;
  const dock = () => { if (is3()) { pn.style.cssText = 'position:static;background:#1b1d22;color:#ddd;border:1px solid #333;border-radius:8px;padding:8px 12px;font:13px system-ui;margin:8px 0'; $('view').after(pn); pn.hidden = false; $('alClose').hidden = true; }
    else if (pn.parentElement !== document.body) { pn.style.cssText = FLOAT; document.body.append(pn); $('alClose').hidden = false; pn.hidden = true; } };
  const vis2 = () => { const on = ['stitch', 'pano', 'panorear', 'pano3'].includes(layout()); btn.hidden = !on || is3(); dock(); if (!on) pn.hidden = true; else if (is3()) fill(); };
  $('layout').addEventListener('change', () => { vis2(); if (!pn.hidden) fill(); }); vis2(); (window as any).__p3fill = fill;
}
document.addEventListener('keydown', e => {
  const tg = e.target as HTMLElement;
  if (tg.tagName === 'INPUT' || tg.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.key === 'i') $('setIn').click(); if (e.key === 'o') $('setOut').click();
  if (e.key === 'ArrowRight') { e.preventDefault(); seek(now() + 5); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seek(now() - 5); }
});

// ---------- rendering ----------
function frameIndex(t: Telemetry | null, local: number) { return t && t.n ? Math.min(t.n - 1, Math.floor(local / (t.duration || 60) * t.n)) : 0; }
function place(si: number, i: number) {
  const t = tel[si];
  if (t?.hasData && t.lat[i]) { const p = streetName(t.lat[i], t.lon[i]); if (p) { lastPlace = p; return p; } if (lastPlace && geoStatus.key && geoEnabled()) return lastPlace; }
  const inf = ev?.info, ev1 = inf ? [inf.street, inf.city].filter(Boolean).join(', ') : ''; if (ev1) return ev1;
  return t?.hasData && t.lat[i] ? `${t.lat[i].toFixed(5)}, ${t.lon[i].toFixed(5)}` : '';
}
function draw() {
  if (!ev || seg < 0) return;
  const m = master();
  const [W, H] = size();
  if (screen.width !== W || screen.height !== H) { screen.width = W; screen.height = H; }
  const src: Record<Camera, HTMLVideoElement> = {};
  for (const c of Object.keys(ev.segments[seg].files)) if (vids[c] && !vids[c].error) src[c] = vids[c];
  const ex = expanded && src[expanded] ? expanded : null;
  const [hx, hy, hw, hh] = compose(ctx, W, H, ex ? 'single' : layout(), ex ?? (src[mainCam()] ? mainCam() : Object.keys(src)[0]), src, {}, ex ? [] : cams);
  const local = m.currentTime, time = new Date(ev.segments[seg].start.getTime() + local * 1000);
  if ($<HTMLInputElement>('hud').checked) {
    const t = tel[seg], i = frameIndex(t, local);
    ctx.save(); ctx.translate(hx, hy);
    if (mode === 'sentry') {
      const inf = ev.info || {};
      drawSentryHud(ctx, hw, hh, time, { reason: inf.reason, camera: inf.camera, trigger: inf.timestamp ? new Date(inf.timestamp) : undefined, place: place(seg, i) }, opts);
    } else drawHud(ctx, hw, hh, { t, i, time, place: place(seg, i) }, opts);
    if (opts.map && trail) drawMapPanel(ctx, hw, hh, trail, segStarts[seg] + local, t?.hasData ? t.heading[i] : 0, opts, place(seg, i));
    ctx.restore();
  }
  cur = now();
  $('time').textContent = `${fmt(cur)} / ${fmt(total)}`;
  drawTrack();
}

// ---------- timeline: speed graph, yellow playhead, draggable trim handles ----------
let vmax = 1;
function drawTrack() {
  const dpr = devicePixelRatio, w = track.width = Math.max(1, track.clientWidth * dpr), h = track.height = 44 * dpr, c = track.getContext('2d')!;
  c.fillStyle = '#1b1f26'; c.fillRect(0, 0, w, h);
  if (!ev || !total) return;
  const x = (t: number) => t / total * w, o = Math.min(outT, total);
  c.fillStyle = 'rgba(227,25,55,0.35)'; c.fillRect(x(inT), 0, x(o) - x(inT), h);
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, x(inT), h); c.fillRect(x(o), 0, w - x(o), h);
  vmax = 1; tel.forEach(t => t?.speed.forEach(v => { if (v > vmax) vmax = v; }));
  c.strokeStyle = '#ff6b7f'; c.lineWidth = 1.5 * dpr; c.beginPath();
  tel.forEach((t, si) => {
    if (!t?.hasData) return;
    const step = Math.max(1, Math.floor(t.n / 400));
    for (let i = 0; i < t.n; i += step) { const px = x(segStarts[si] + i / t.n * t.duration), py = h - 4 * dpr - t.speed[i] / vmax * (h - 10 * dpr); i ? c.lineTo(px, py) : c.moveTo(px, py); }
  });
  c.stroke();
  c.fillStyle = '#555'; segStarts.forEach(s => c.fillRect(x(s), 0, 1, h));
  if (ev.info?.timestamp) {
    const tt = (new Date(ev.info.timestamp).getTime() - ev.segments[0].start.getTime()) / 1000;
    if (tt >= 0 && tt <= total) { c.fillStyle = '#c86bff'; c.fillRect(x(tt) - 1, 0, 2 * dpr, h); }
  }
  // speed-ramp markers (orange): slowed region + triangle at the trigger
  if (F.ramp.on) for (const g of triggers) {
    const a = x(g.t - F.ramp.hold / 2 - F.ramp.ramp), b = x(g.t + F.ramp.hold / 2 + F.ramp.ramp);
    c.fillStyle = 'rgba(255,150,0,0.28)'; c.fillRect(a, 0, b - a, h);
    c.fillStyle = '#ff9600'; c.beginPath(); c.moveTo(x(g.t) - 5 * dpr, h); c.lineTo(x(g.t) + 5 * dpr, h); c.lineTo(x(g.t), h - 9 * dpr); c.fill();
  }
  // trim handles (white brackets)
  const bracket = (px: number, dir: number) => {
    c.fillStyle = '#fff'; c.fillRect(px - (dir < 0 ? 0 : 4 * dpr), 0, 4 * dpr, h);
    c.fillRect(px, 0, dir * 9 * dpr, 3 * dpr); c.fillRect(px, h - 3 * dpr, dir * 9 * dpr, 3 * dpr);
  };
  bracket(x(inT), 1); bracket(x(o), -1);
  // yellow playhead
  const px = x(cur);
  c.fillStyle = '#ffd400'; c.fillRect(px - 1.5 * dpr, 0, 3 * dpr, h);
  c.beginPath(); c.moveTo(px - 6 * dpr, 0); c.lineTo(px + 6 * dpr, 0); c.lineTo(px, 8 * dpr); c.fill();
}
addEventListener('resize', drawTrack);
let drag: 'in' | 'out' | 'head' | null = null, wasPlaying = false, seekBusy = false, seekWant = -1;
const tAt = (e: PointerEvent) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(total, (e.clientX - r.left) / r.width * total)); };
function lazySeek(t: number) {
  seekWant = t; cur = t; drawTrack();
  if (seekBusy) return;
  seekBusy = true;
  const go = () => { const w = seekWant; seekWant = -1; seek(w).then(() => { if (seekWant >= 0) go(); else seekBusy = false; }); };
  go();
}
track.addEventListener('pointerdown', e => {
  if (!ev) return;
  const r = track.getBoundingClientRect(), px = e.clientX - r.left, X = (t: number) => t / total * r.width;
  drag = Math.abs(px - X(inT)) < 8 ? 'in' : Math.abs(px - X(Math.min(outT, total))) < 8 ? 'out' : 'head';
  track.setPointerCapture(e.pointerId);
  wasPlaying = playing; pause();
  onDrag(e);
});
function onDrag(e: PointerEvent) {
  const t = tAt(e);
  if (drag === 'in') { inT = Math.min(t, Math.min(outT, total) - 0.5); $('inT').textContent = fmt(inT); lazySeek(inT); }
  else if (drag === 'out') { outT = Math.max(t, inT + 0.5); if (outT >= total - 0.05) outT = Infinity; $('outT').textContent = outT === Infinity ? 'end' : fmt(outT); lazySeek(Math.min(outT, total) - 0.05); }
  else if (drag === 'head') lazySeek(t);
}
track.addEventListener('pointermove', e => {
  if (drag) return onDrag(e);
  if (!ev) return;
  const r = track.getBoundingClientRect(), px = e.clientX - r.left, X = (t: number) => t / total * r.width;
  track.style.cursor = Math.abs(px - X(inT)) < 8 || Math.abs(px - X(Math.min(outT, total))) < 8 ? 'ew-resize' : 'pointer';
});
track.addEventListener('pointerup', () => { drag = null; if (wasPlaying) setTimeout(play, 50); });
$('setIn').onclick = () => { inT = now(); if (inT >= outT) outT = Infinity; $('inT').textContent = fmt(inT); drawTrack(); };
$('setOut').onclick = () => { outT = Math.max(inT + 0.5, now()); $('outT').textContent = fmt(outT); drawTrack(); };
const api = { resetStitch: () => { resetStitch(); draw(); }, autoAlign: () => { $('alAuto').click(); return $('alMsg').textContent; }, stitch: (c: string) => stitchPref(c, stitchGroup(layout())), setStitch: (c: string, v: any) => { setStitchPref(c, v, stitchGroup(layout())); draw(); }, get xopts() { return { ...(xopts ?? {}), hud: xHud }; }, get opts() { return { ...opts }; }, get features() { return JSON.parse(JSON.stringify(F)); }, get triggers() { return triggers; }, get trail() { return trail && { n: trail.x.length, single: trail.single, radius: trail.radius }; }, get support() { return support; }, memPlan: (...a: Parameters<typeof memPlan>) => memPlan(...a), get state() { return { inT, outT, cur, total, layout: layout(), cams, mode, expanded, geo: geoStatus, place: ev && seg >= 0 ? place(seg, frameIndex(tel[seg], master().currentTime)) : '' }; }, seek, get events() { return events.map(e => ({ id: e.id, name: e.name, cat: cat(e) })); } };
(window as any).__teslacam = (window as any).__teslacutcam = api;

function stats() {
  const all = tel.filter((t): t is Telemetry => !!t?.hasData);
  if (!all.length) { $('stats').textContent = ev ? `${ev.segments.length} clip(s), ${fmt(total)} total. No embedded telemetry (needs Tesla firmware 2025.20+ dashcam clips).` : ''; return; }
  let n = 0, sum = 0, max = 0, ap = 0, g = 0, dist = 0;
  for (const t of all) for (let i = 0; i < t.n; i++) {
    n++; sum += t.speed[i]; max = Math.max(max, t.speed[i]); if (t.ap[i]) ap++;
    g = Math.max(g, Math.hypot(t.ax[i], t.ay[i]) / 9.80665); dist += t.speed[i] * t.duration / t.n;
  }
  const k = opts.units === 'mph' ? 2.23694 : 3.6, u = opts.units === 'mph' ? 'mph' : 'km/h';
  $('stats').textContent = `Max ${(max * k).toFixed(0)} ${u} · Avg ${(sum / n * k).toFixed(0)} ${u} · Distance ${(dist / (opts.units === 'mph' ? 1609.34 : 1000)).toFixed(2)} ${opts.units === 'mph' ? 'mi' : 'km'} · FSD/Autopilot ${(ap / n * 100).toFixed(0)}% · Peak ${g.toFixed(2)} g`;
}

// ---------- export ----------
const XLABELS: [keyof OverlayOpts, string, Mode | 'both'][] = [['map', 'Map', 'both'], ['clock', 'Date/Time', 'both'], ['speed', 'Speed', 'driving'], ['gear', 'Gear', 'driving'], ['autopilot', 'FSD/Autopilot', 'driving'], ['steering', 'Steering', 'driving'], ['pedals', 'ACC/BRK', 'driving'], ['blinkers', 'Blinkers', 'driving'], ['gforce', 'G-force', 'driving'], ['compass', 'Heading', 'driving'], ['location', 'Location', 'both'], ['sentryBadge', 'Sentry badge', 'sentry'], ['sentryTrigger', 'Sentry trigger info', 'sentry']];
let xopts: OverlayOpts | null = null;
let xHud = true;
const xLayout = () => $<HTMLSelectElement>('xLayout').value as Layout;
function xSize(): [number, number] { let W = +$<HTMLSelectElement>('xRes').value.split('x')[0]; if (xLayout() === 'pano3' || xLayout() === 'pano') W = Math.min(4096, Math.max(W, 3840)); return [W, Math.round(W * layoutAspect(xLayout()) / 2) * 2]; }
function xRefresh() {
  xHud = $<HTMLInputElement>('xHudOn').checked;
  readFeatureUI();
  $('xItems').classList.toggle('off', !xHud);
  $('xItems').querySelectorAll('input').forEach(i => { (xopts as any)[(i as HTMLInputElement).dataset.k!] = (i as HTMLInputElement).checked; });
  const [W, H] = xSize(), pv = $<HTMLCanvasElement>('xPreview');
  pv.height = Math.round(pv.width * H / W);
  const c = pv.getContext('2d')!, src: Record<Camera, HTMLVideoElement> = {};
  for (const k of Object.keys(ev!.segments[seg].files)) if (vids[k]) src[k] = vids[k];
  const [hx, hy, hw, hh] = compose(c, pv.width, pv.height, xLayout(), src[mainCam()] ? mainCam() : Object.keys(src)[0], src, {}, cams);
  if (xHud) {
    const m = master(), t = tel[seg], i = frameIndex(t, m.currentTime), time = new Date(ev!.segments[seg].start.getTime() + m.currentTime * 1000);
    c.save(); c.translate(hx, hy);
    if (mode === 'sentry') { const inf = ev!.info || {}; drawSentryHud(c, hw, hh, time, { reason: inf.reason, camera: inf.camera, trigger: inf.timestamp ? new Date(inf.timestamp) : undefined, place: place(seg, i) }, xopts!); }
    else drawHud(c, hw, hh, { t, i, time, place: place(seg, i) }, xopts!);
    if (xopts!.map && trail) drawMapPanel(c, hw, hh, trail, segStarts[seg] + m.currentTime, t?.hasData ? t.heading[i] : 0, xopts!, place(seg, i));
    c.restore();
  }
  drawCardPreview();
  const on = XLABELS.filter(([k, , m]) => (m === 'both' || m === mode) && (xopts as any)?.[k] !== false).map(x => x[1]);
  $('xSummary').textContent = `${W}×${H} · ${$<HTMLSelectElement>('xLayout').selectedOptions[0].text} · ${fmt(inT)}–${fmt(Math.min(outT, total))} (${(Math.min(outT, total) - inT).toFixed(1)} s) · HUD: ${xHud ? (on.join(', ') || 'nothing selected') : 'off'}` +
    (F.ramp.on ? ` · Speed ramps: ${rampsIn().length}` : '') + (F.stab.on ? ' · Stabilized' : '') + (F.title.on ? ' · Title card' : '') + (F.end.on ? ' · End card' : '');
}
$('export').onclick = () => {
  if (!ev) return;
  pause();
  xopts = { ...opts, ...(xopts ?? {}), units: opts.units };
  $<HTMLSelectElement>('xLayout').innerHTML = $<HTMLSelectElement>('layout').innerHTML.replace(/<option value="auto">.*?<\/option>/, '');
  $<HTMLSelectElement>('xLayout').value = layout();
  $<HTMLSelectElement>('xRes').innerHTML = $<HTMLSelectElement>('res').innerHTML; $<HTMLSelectElement>('xRes').value = $<HTMLSelectElement>('res').value;
  ($<HTMLInputElement>($<HTMLInputElement>('hud').checked ? 'xHudOn' : 'xHudOff')).checked = true;
  writeFeatureUI();
  $('xItems').innerHTML = XLABELS.filter(([, , m]) => m === 'both' || m === mode).map(([k, l]) => `<label><input type="checkbox" data-k="${k}" ${(xopts as any)?.[k] !== false ? 'checked' : ''}> ${l}</label>`).join('');
  xRefresh();
  $<HTMLDialogElement>('exportDlg').showModal();
};
['xLayout', 'xRes', 'xHudOn', 'xHudOff', 'xItems'].forEach(id => $(id).addEventListener('change', xRefresh));
$('exportDlg').addEventListener('input', e => { if ((e.target as HTMLElement).closest('.xopt')) xRefresh(); });
$('exportDlg').addEventListener('close', () => { if ($<HTMLDialogElement>('exportDlg').returnValue === 'go') runExport(); });
async function runExport() {
  if (!ev) return;
  if (!support?.ok) return showError('Export unavailable', new Error(support?.message || 'Export needs a browser with WebCodecs (Chrome or Edge).'));
  const [W, H] = xSize();
  const part: Part = { event: ev, telemetry: tel, segStarts, from: inT, to: Math.min(outT, total), mode, place, trail: trail ?? undefined, rate: F.ramp.on && triggers.length ? (t: number) => rateAt(triggers, F.ramp, t) : undefined };
  const name = `TeslaCutCam_${ev.segments[0].stamp}${mode === 'sentry' ? '_sentry' : ''}.mp4`;
  await doExport([part], { ...xopts! }, xHud, xLayout(), W, H, name);
}
const memPlan = (e: TeslaEvent | null = ev, lay: Layout = layout(), W = 1920, H = 1080) => {
  if (!e) return planChunks(F.perf, 5e6, 1280 * 960, 4, W * H);
  const s0 = e.segments[0], files = Object.values(s0.files), c = lay === 'single' ? 1 : files.length;
  const bytes = lay === 'single' ? (s0.files.front ?? files[0]).size : files.reduce((a, f) => a + f.size, 0);
  return planChunks(F.perf, bytes / 60, 1448 * 938, c, W * H);
};
async function doExport(parts: Part[], overlay: OverlayOpts, hud: boolean, lay: Layout, W: number, H: number, name: string, sink?: FileSystemWritableFileStream, quiet = false) {
  const plan = memPlan(parts[0].event, lay, W, H);
  const prog = $<HTMLProgressElement>('prog'); prog.hidden = false; $('cancel').hidden = false; $<HTMLButtonElement>('export').disabled = true;
  abort = new AbortController();
  const t0 = performance.now();
  try {
    const res = await exportVideo({
      parts, layout: lay, main: mainCam(),
      overlay, hud, width: W, height: H, bitrate: Math.min(40e6, W * H * 5 * plan.bitrateMul),
      chunkSec: plan.chunkSec, queue: plan.queue,
      stab: F.stab.on ? { ...F.stab } : undefined,
      defish: [...getDefish()],
      title: F.title.on ? { ...F.title } : undefined, end: F.end.on ? { ...F.end, style: F.title.style, font: F.title.font, size: F.title.size, color: F.title.color, bgColor: F.title.bgColor } : undefined,
      logo, sink, signal: abort.signal,
      onProgress: (p, msg) => { prog.value = p; if (msg) $('stats').textContent = 'Export: ' + msg; },
    });
    if (sink) await sink.close();
    (window as any).__lastExport = { size: res.bytes, ms: performance.now() - t0, blob: res.blob, frames: res.frames, seconds: res.seconds, chunks: res.chunks, mem: res.mem, plan, stab: res.stab, name };
    (window as any).__exports = [...((window as any).__exports ?? []), (window as any).__lastExport];
    if (res.blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(res.blob); a.download = name; a.click(); }
    $('stats').textContent = `Exported ${(res.bytes / 1e6).toFixed(1)} MB (${W}×${H}, ${res.seconds.toFixed(1)} s) in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${res.chunks} chunk(s) · ${plan.note}.`;
    return true;
  } catch (err) {
    if (sink) await sink.abort().catch(() => {});
    (window as any).__lastExport = { error: String(err) };
    if ((err as Error).name !== 'AbortError') { if (!quiet) showError('Export failed', err); else throw err; } else $('stats').textContent = 'Export cancelled.';
    return false;
  } finally { prog.hidden = true; $('cancel').hidden = true; $<HTMLButtonElement>('export').disabled = false; }
}
$('cancel').onclick = () => abort?.abort();

// ---------- settings ----------
$('settingsBtn').onclick = () => {
  $<HTMLSelectElement>('units').value = opts.units; geoUI();
  $<HTMLSelectElement>('perf').value = F.perf; $<HTMLInputElement>('remember').checked = F.remember;
  $<HTMLSelectElement>('mapCorner').value = opts.mapCorner ?? 'tr'; $<HTMLSelectElement>('mapNorth').value = opts.mapNorthUp === false ? '0' : '1';
  $<HTMLSelectElement>('mapStyle').value = opts.mapStyle ?? 'aerial'; $<HTMLSelectElement>('mapZoom').value = opts.mapZoom ?? 'close';
  memInfo();
  $<HTMLDialogElement>('settings').showModal();
};
$('settings').addEventListener('close', () => {
  opts.units = $<HTMLSelectElement>('units').value as 'mph' | 'kmh';
  opts.mapCorner = $<HTMLSelectElement>('mapCorner').value as any; opts.mapNorthUp = $<HTMLSelectElement>('mapNorth').value === '1';
  opts.mapStyle = $<HTMLSelectElement>('mapStyle').value as any; opts.mapZoom = $<HTMLSelectElement>('mapZoom').value as any;
  localStorage.setItem('teslacam.overlay', JSON.stringify(opts));
  F.perf = $<HTMLSelectElement>('perf').value as Perf; F.remember = $<HTMLInputElement>('remember').checked; saveF();
  if (!F.remember) idbSet('lastFolder', undefined);
  lastFolderUI();
  stats(); draw();
});
addEventListener('error', e => showError('Unexpected error', e.error ?? e.message));
addEventListener('unhandledrejection', e => showError('Unexpected error', e.reason));
drawTrack();

// ---------- street names (local helper) ----------
function geoUI() {
  const cb = $<HTMLInputElement>('streets');
  cb.checked = geoStatus.key && geoEnabled(); cb.disabled = !geoStatus.key;
  $('geoStatus').textContent = !geoStatus.helper ? 'Street names off: no /geo helper here (portable version: start "Start Tesla Cut Cam Export.bat"). Showing event.json street/city or coordinates instead.'
    : !geoStatus.key ? 'Street names off: the helper has no LocationIQ key configured.'
    : `Street names available via the /geo helper${geoEnabled() ? '' : ' (currently turned off)'}.`;
}
$('streets').addEventListener('change', e => { setGeoEnabled((e.target as HTMLInputElement).checked); lastPlace = ''; geoUI(); draw(); });
checkGeo().then(geoUI);
setTileListener(() => { if (opts.map) draw(); });

// ---------- click-to-expand camera ----------
let expanded: Camera | null = null, expandedAt = 0;
function setExpanded(c: Camera | null) {
  expanded = c; expandedAt = Date.now();
  $('collapse').hidden = !c; $('expChip').hidden = !c;
  if (c) ($('expChip').querySelector('span') as HTMLElement).textContent = camLabel(c);
  screen.classList.toggle('exp', !!c);
  draw();
}
screen.addEventListener('click', e => {
  if (!ev || seg < 0 || expanded) return;
  const r = screen.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * screen.width, y = (e.clientY - r.top) / r.height * screen.height;
  // Must use exactly the camera list/order compose() draws with (event cams in display order), not the
  // clip's file order, or grid/PiP slots map to the wrong camera.
  const files = ev.segments[seg].files, have = cams.length ? cams : Object.keys(files);
  const main = files[mainCam()] ? mainCam() : Object.keys(files)[0];
  const p = plan(screen.width, screen.height, layout(), main, have);
  // last matching cell wins (PiP insets are drawn on top of the main view)
  const hit = [...p.cells].reverse().find(({ r: [cx, cy, cw, ch] }) => x >= cx && x < cx + cw && y >= cy && y < cy + ch);
  if (hit) setExpanded(hit.cam);
});
screen.addEventListener('dblclick', () => { if (expanded && Date.now() - expandedAt > 450) setExpanded(null); });
$('collapse').onclick = () => setExpanded(null);
$('expChip').onclick = () => setExpanded(null);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && expanded && !document.querySelector('dialog[open]')) setExpanded(null); });
$('layout').addEventListener('change', () => { if (expanded) setExpanded(null); });
$('cam').addEventListener('change', () => { // camera picker: show that camera on its own (click the chip / Esc to return to the layout)
  const c = mainCam(); const l = layout();
  if (l === 'single' || l === 'pip') { if (expanded) setExpanded(null); else draw(); } else setExpanded(c);
});

// ======================= round 4 features =======================
// ---------- speed ramps ----------
function computeTriggers() {
  triggers = ev && F.ramp.on ? findTriggers(tel, segStarts, F.ramp, ev.info, ev.segments[0].start) : [];
}
const rampsIn = () => triggers.filter(g => g.t >= inT && g.t <= Math.min(outT, total));

// ---------- export-dialog feature controls ----------
const num = (id: string) => +$<HTMLInputElement>(id).value;
function writeFeatureUI() {
  const r = F.ramp, st = F.stab, t = F.title;
  $<HTMLInputElement>('xRamp').checked = r.on;
  $('xRampTrig').querySelectorAll('input').forEach(i => (i as HTMLInputElement).checked = (r as any)[(i as HTMLInputElement).dataset.r!]);
  $<HTMLInputElement>('xRampFactor').value = String(r.factor); $<HTMLInputElement>('xRampThr').value = String(r.threshold); $<HTMLInputElement>('xRampDur').value = String(r.ramp);
  $<HTMLInputElement>('xStab').checked = st.on; $<HTMLInputElement>('xStabStr').value = String(st.strength); $<HTMLInputElement>('xStabCrop').value = String(st.crop); $<HTMLSelectElement>('xStabCams').value = st.cams;
  $<HTMLInputElement>('xTitle').checked = t.on; $<HTMLInputElement>('xEnd').checked = F.end.on;
  $<HTMLSelectElement>('xCardStyle').value = t.style; $<HTMLInputElement>('xCardTitle').value = t.title; $<HTMLInputElement>('xCardSub').value = t.subtitle;
  $<HTMLInputElement>('xCardDur').value = String(t.duration);
  const fs = $<HTMLSelectElement>('xCardFont'); if (!fs.options.length) fs.innerHTML = FONTS.map(f => `<option>${f}</option>`).join(''); fs.value = t.font;
  $<HTMLInputElement>('xCardSize').value = String(t.size); $<HTMLInputElement>('xCardColor').value = t.color;
  $<HTMLSelectElement>('xCardBg').value = t.bg; $<HTMLInputElement>('xCardBgColor').value = t.bgColor;
  $<HTMLInputElement>('xEndTitle').value = F.end.title; $<HTMLInputElement>('xEndDur').value = String(F.end.duration);
  $('xLogoName').textContent = logo ? `Logo: ${logoName}` : 'No logo';
}
function readFeatureUI() {
  const r = F.ramp, wasOn = r.on, before = JSON.stringify(r);
  r.on = $<HTMLInputElement>('xRamp').checked;
  $('xRampTrig').querySelectorAll('input').forEach(i => (r as any)[(i as HTMLInputElement).dataset.r!] = (i as HTMLInputElement).checked);
  r.factor = num('xRampFactor'); r.threshold = num('xRampThr'); r.ramp = num('xRampDur');
  $('xRampFactorV').textContent = `${r.factor.toFixed(2)}×`; $('xRampThrV').textContent = `${r.threshold.toFixed(2)} g`; $('xRampDurV').textContent = `${r.ramp.toFixed(1)} s`;
  if (before !== JSON.stringify(r) || wasOn !== r.on) { computeTriggers(); drawTrack(); }
  const list = rampsIn();
  $('xRampInfo').textContent = !r.on ? '' : !tel.some(t => t?.hasData) && !r.sentry ? 'No telemetry in this clip, so no ramps can be detected.'
    : `${list.length} ramp${list.length === 1 ? '' : 's'} in the trimmed range${list.length ? ': ' + list.slice(0, 6).map(g => `${TRIGGER_LABEL[g.type]} at ${fmt(g.t)}`).join(', ') + (list.length > 6 ? '…' : '') : ''}. Marked orange on the timeline.`;
  const st = F.stab; st.on = $<HTMLInputElement>('xStab').checked; st.strength = num('xStabStr'); st.crop = num('xStabCrop'); st.cams = $<HTMLSelectElement>('xStabCams').value as any;
  $('xStabCropV').textContent = `${Math.round(st.crop * 100)}%`;
  const t = F.title; t.on = $<HTMLInputElement>('xTitle').checked; F.end.on = $<HTMLInputElement>('xEnd').checked;
  t.style = $<HTMLSelectElement>('xCardStyle').value as any; t.title = $<HTMLInputElement>('xCardTitle').value; t.subtitle = $<HTMLInputElement>('xCardSub').value;
  t.duration = Math.max(1, num('xCardDur') || 3); t.font = $<HTMLSelectElement>('xCardFont').value; t.size = num('xCardSize') || 72;
  t.color = $<HTMLInputElement>('xCardColor').value; t.bg = $<HTMLSelectElement>('xCardBg').value as any; t.bgColor = $<HTMLInputElement>('xCardBgColor').value;
  F.end.title = $<HTMLInputElement>('xEndTitle').value; F.end.duration = Math.max(1, num('xEndDur') || 2);
  saveF();
}
function drawCardPreview() {
  const cv = $<HTMLCanvasElement>('xCardPreview'), c = cv.getContext('2d')!;
  let bg: CanvasImageSource | null = null;
  if (F.title.bg === 'blur') bg = $<HTMLCanvasElement>('xPreview');
  drawCard(c, cv.width, cv.height, F.title, logo, bg);
}
async function loadLogo(blob: Blob) {
  // SVGs go through an <img> first so createImageBitmap works everywhere
  if (blob.type === 'image/svg+xml') {
    const url = URL.createObjectURL(blob), img = new Image(); img.src = url; await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512, cv = new OffscreenCanvas(w, h);
    cv.getContext('2d')!.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
    return createImageBitmap(cv);
  }
  return createImageBitmap(blob);
}
$<HTMLInputElement>('xLogo').onchange = async e => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  try { logo = await loadLogo(f); logoName = f.name; await idbSet('logo', { name: f.name, blob: f }); if (F.title.style === 'text') { F.title.style = 'logo+text'; $<HTMLSelectElement>('xCardStyle').value = 'logo+text'; } writeFeatureUI(); xRefresh(); }
  catch (err) { showError('Could not read that logo', err); }
};
$('xLogoClear').onclick = async () => { logo = null; logoName = ''; await idbSet('logo', undefined); writeFeatureUI(); xRefresh(); };
idbGet<{ name: string; blob: Blob }>('logo').then(async v => { if (v?.blob) { try { logo = await loadLogo(v.blob); logoName = v.name; } catch { /* ignore */ } } });

// ---------- performance / memory ----------
function memInfo() {
  const r = detectRam(), p = memPlan(ev, layout(), ...size());
  $('memInfo').textContent = `Detected: ${r.gb} GB (${r.source})${r.heapLimitMB ? `, JS heap limit ${r.heapLimitMB} MB` : ''}. Current plan: ${p.chunkSec}-second chunks, decoder queue ${p.queue}, ~${p.budgetMB} MB budget.`;
}

// ---------- open last folder ----------
async function lastFolderUI() {
  const h = F.remember && 'showDirectoryPicker' in window ? await idbGet<FileSystemDirectoryHandle>('lastFolder') : undefined;
  const b = $<HTMLButtonElement>('lastFolder'); b.hidden = !h; if (h) b.textContent = `Open last folder (${h.name})`;
}
$('lastFolder').onclick = async () => {
  const h = await idbGet<FileSystemDirectoryHandle>('lastFolder');
  if (!h) return lastFolderUI();
  try {
    let perm = await (h as any).queryPermission?.({ mode: 'read' }) ?? 'granted';
    if (perm !== 'granted') perm = await (h as any).requestPermission({ mode: 'read' });
    if (perm !== 'granted') { $('stats').textContent = 'Permission for the last folder was not granted. Pick the folder again with "Open TeslaCam folder".'; return; }
    busy('Scanning folder…');
    load(await collect(h));
  } catch (err) {
    busy(null);
    $('stats').textContent = `Couldn't reopen "${h.name}" (it may have been moved, or the USB drive is not plugged in). Pick it again with "Open TeslaCam folder".`;
    console.warn('[TeslaCutCam] last folder', err);
  }
};
lastFolderUI();

// ---------- browser support ----------
async function hevcCheck(f: File | undefined) {
  if (!f || !support?.webcodecs) return;
  try {
    const head = new Uint8Array(await f.slice(0, Math.min(f.size, 4 << 20)).arrayBuffer());
    const s = new TextDecoder('latin1').decode(head);
    if (/hvc1|hev1/.test(s) && !(await canDecode('hvc1.1.6.L93.B0', 1280, 960))) showBanner('These clips are HEVC (H.265), which this browser cannot decode with WebCodecs. Use Chrome or Edge on Windows with HEVC hardware support, or re-encode the clips to H.264.');
  } catch { /* ignore */ }
}
function showBanner(msg: string) { const b = $('unsupported'); b.textContent = msg; b.hidden = !msg; }
detectSupport().then(s => {
  support = s; if (s.message) showBanner(s.message);
  if (!s.ok) { const b = $<HTMLButtonElement>('export'); b.disabled = true; b.title = s.message; }
});

// ---------- Sentry contact sheet + day batch export ----------
const sentryEvents = () => events.filter(e => cat(e) === 'Sentry');
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function updateSheetBtn() { const n = sentryEvents().length; const b = $('sheetBtn'); b.hidden = !n; b.textContent = `Sentry contact sheet (${n})`; }
function renderSheet() {
  const byDay = new Map<string, TeslaEvent[]>();
  for (const e of sentryEvents()) { const k = dayKey(e.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(e); }
  const root = $('sheet'); root.innerHTML = '';
  for (const [day, list] of [...byDay].sort((a, b) => b[0].localeCompare(a[0]))) {
    const h = document.createElement('h4');
    h.innerHTML = `${day} · ${list.length} event${list.length > 1 ? 's' : ''} <button type="button" data-m="files">Export as files…</button><button type="button" data-m="downloads">Download one by one</button><button type="button" data-m="combined">One combined video</button>`;
    h.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = () => exportDay(list, (b as HTMLButtonElement).dataset.m as any, day));
    const g = document.createElement('div'); g.className = 'grid';
    for (const e of list.sort((a, b) => a.start.getTime() - b.start.getTime())) {
      const d = document.createElement('div'); d.className = 'th'; d.dataset.id = e.id;
      const trig = e.info?.timestamp ? new Date(e.info.timestamp) : e.start;
      d.innerHTML = `${e.thumb ? `<img src="${URL.createObjectURL(e.thumb)}">` : '<img>'}<span>${trig.toLocaleTimeString()}${e.info?.camera ? ' · ' + (({ '3': 'Left pillar', '4': 'Right pillar', '5': 'Left rep.', '6': 'Right rep.', '7': 'Rear' } as any)[e.info.camera] ?? 'Front') : ''}${e.info?.city ? ' · ' + e.info.city : ''}</span>`;
      d.onclick = async () => {
        $<HTMLDialogElement>('sheetDlg').close();
        await openEvent(e); renderList(false);
        const t = (trig.getTime() - e.segments[0].start.getTime()) / 1000;
        await seek(Math.max(0, Math.min(total - 0.1, t - 2)));
      };
      g.append(d);
      if (!e.thumb) frameThumb(e, trig).then(u => { if (u) d.querySelector('img')!.src = u; });
    }
    root.append(h, g);
  }
}
// no thumb.png in the folder: grab a frame from the triggering camera at the trigger time
const thumbCache = new Map<string, string>();
async function frameThumb(e: TeslaEvent, trig: Date): Promise<string | null> {
  if (thumbCache.has(e.id)) return thumbCache.get(e.id)!;
  const camOf: Record<string, string> = { '0': 'front', '3': 'left_pillar', '4': 'right_pillar', '5': 'left_repeater', '6': 'right_repeater', '7': 'back' };
  let si = e.segments.findIndex((s, i) => trig >= s.start && (!e.segments[i + 1] || trig < e.segments[i + 1].start)); if (si < 0) si = 0;
  const s = e.segments[si], f = s.files[camOf[e.info?.camera ?? '0'] ?? 'front'] ?? s.files.front ?? Object.values(s.files)[0];
  if (!f) return null;
  const v = document.createElement('video'), url = URL.createObjectURL(f);
  try {
    v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = j; });
    v.currentTime = Math.max(0, Math.min((v.duration || 1) - 0.1, (trig.getTime() - s.start.getTime()) / 1000));
    await new Promise((r, j) => { v.onseeked = r; v.onerror = j; setTimeout(r, 3000); });
    const c = document.createElement('canvas'); c.width = 320; c.height = Math.round(320 * (v.videoHeight || 960) / (v.videoWidth || 1280));
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    const u = c.toDataURL('image/jpeg', 0.8); thumbCache.set(e.id, u); return u;
  } catch { return null; } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); }
}
$('sheetBtn').onclick = () => { renderSheet(); $<HTMLDialogElement>('sheetDlg').showModal(); };
async function eventPart(e: TeslaEvent): Promise<Part> {
  const T = await Promise.all(e.segments.map(s => parse(s.files.front ?? Object.values(s.files)[0])));
  const st: number[] = []; let tot = 0; T.forEach(t => { st.push(tot); tot += t?.duration || 60; });
  const inf = e.info || {}, where = [inf.street, inf.city].filter(Boolean).join(', ');
  return { event: e, telemetry: T, segStarts: st, from: 0, to: tot, mode: 'sentry', place: () => where, trail: buildTrail(T, st, e.info) ?? undefined };
}
async function exportDay(list: TeslaEvent[], how: 'files' | 'downloads' | 'combined', day: string) {
  $<HTMLDialogElement>('sheetDlg').close(); pause();
  const W = +$<HTMLSelectElement>('res').value.split('x')[0], lay: Layout = 'grid', H = Math.round(W * layoutAspect(lay) / 2) * 2;
  const ov: OverlayOpts = { ...opts, ...(xopts ?? {}), units: opts.units }, hud = $<HTMLInputElement>('hud').checked;
  const fname = (e: TeslaEvent) => `TeslaCutCam_${e.segments[0].stamp}_sentry.mp4`;
  const results: string[] = [];
  try {
    busy(`Preparing ${list.length} Sentry events…`);
    const parts: Part[] = []; for (const e of list) parts.push(await eventPart(e));
    busy(null);
    if (how === 'combined') { await doExport(parts, ov, hud, lay, W, H, `TeslaCutCam_Sentry_${day}.mp4`, undefined, true); results.push('combined'); }
    else {
      let dir: FileSystemDirectoryHandle | null = null;
      if (how === 'files') {
        if (!('showDirectoryPicker' in window)) { $('stats').textContent = 'Saving into a folder is not supported in this browser; downloading one by one instead.'; how = 'downloads'; }
        else { try { dir = await (window as any).showDirectoryPicker({ id: 'teslacutcam-out', mode: 'readwrite' }); } catch { return; } }
      }
      for (let k = 0; k < parts.length; k++) {
        const e = list[k];
        $('stats').textContent = `Sentry batch ${k + 1}/${parts.length}…`;
        const sink = dir ? await (await dir.getFileHandle(fname(e), { create: true })).createWritable() : undefined;
        const ok = await doExport([parts[k]], ov, hud, lay, W, H, fname(e), sink, true);
        if (!ok) break; results.push(fname(e));
        if (!dir) await new Promise(r => setTimeout(r, 600)); // let the browser start each download
      }
    }
    $('stats').textContent = `Sentry ${day}: exported ${results.length} file(s)${how === 'files' ? ' into the chosen folder' : ''}.`;
    (window as any).__batch = { how, files: results };
  } catch (err) { busy(null); (window as any).__batch = { how, error: String(err) }; showError('Sentry batch export failed', err); }
}

// Fisheye / skew correction: one checkbox per wide camera, saved, used by the live view and export.
setDefish(JSON.parse(localStorage.getItem('tcc.defish2') || '[]'));
document.querySelectorAll<HTMLInputElement>('.dfcb').forEach(cb => {
  cb.checked = getDefish().has(cb.value);
  cb.addEventListener('change', () => {
    const on = [...document.querySelectorAll<HTMLInputElement>('.dfcb')].filter(x => x.checked).map(x => x.value);
    setDefish(on); localStorage.setItem('tcc.defish2', JSON.stringify(on)); draw();
  });
});

declare const __BUILD__: string;
{ const b = document.getElementById("buildv"); if (b) b.textContent = __BUILD__ + " · seams v7"; }
