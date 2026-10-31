// Tesla Cut Cam Export — export pipeline.
// Demux with mp4box (lazily: only ftyp+moov are parsed up front and sample bytes are read from disk
// chunk by chunk), decode with WebCodecs, composite + HUD on an OffscreenCanvas, encode H.264 and mux
// into ONE fragmented MP4 (init segment once, then moof/mdat fragments appended). Output goes to a
// File System Access stream when available, otherwise into Blob parts that are consolidated per chunk.
import * as MP4Box from 'mp4box';
import { Muxer, StreamTarget } from 'mp4-muxer';
import { eventCams, camLabel, type Camera, type TeslaEvent } from './library';
import type { Telemetry } from './sei';
import { setDefish } from './defish';
import { compose, type Layout, type Xf } from './compose';
import { drawHud, drawSentryHud, type OverlayOpts, type Mode } from './overlay';
import { drawCard, type CardOpts } from './cards';
import { drawMapPanel, type Trail } from './map';
import { Stabilizer, type StabOpts } from './stab';

interface Sample { data: Uint8Array | null; off: number; size: number; ts: number; dur: number; key: boolean; desc: number; }
export interface Track { codec: string; codecs: string[]; width: number; height: number; descriptions: Uint8Array[]; samples: Sample[]; file: File; lazy: boolean; fragmented: boolean; }

async function readBoxes(file: File) {
  const out: { type: string; start: number; size: number }[] = [];
  let pos = 0;
  while (pos + 8 <= file.size && out.length < 10000) {
    const b = new DataView(await file.slice(pos, Math.min(file.size, pos + 16)).arrayBuffer());
    let size = b.getUint32(0);
    const type = String.fromCharCode(b.getUint8(4), b.getUint8(5), b.getUint8(6), b.getUint8(7));
    if (size === 1 && b.byteLength >= 16) size = Number(b.getBigUint64(8)); else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    out.push({ type, start: pos, size }); pos += size;
  }
  return out;
}

function descOf(entry: any): Uint8Array {
  const box = entry.avcC || entry.hvcC;
  const ds = new (MP4Box as any).DataStream(undefined, 0, (MP4Box as any).DataStream.BIG_ENDIAN);
  box.write(ds);
  return new Uint8Array(ds.buffer.slice(8, ds.position ?? undefined));
}

/** Parses a clip. Regular MP4s are parsed from moov only (sample bytes read lazily);
 *  fragmented MP4s (moof) fall back to a full in-memory parse. */
export async function demux(file: File): Promise<Track> {
  const boxes = await readBoxes(file);
  const moov = boxes.find(b => b.type === 'moov');
  const fragmented = boxes.some(b => b.type === 'moof');
  const lazy = !!moov && !fragmented && moov.size < 128e6;
  const mp4 = (MP4Box as any).createFile();
  let track: Track | null = null, err: unknown = null, shift = 0;
  mp4.onError = (e: unknown) => { err = e; };
  mp4.onReady = (info: any) => {
    const v = info.videoTracks[0];
    if (!v) { err = new Error('no video track in ' + file.name); return; }
    const trak = mp4.getTrackById(v.id);
    const entries = trak.mdia.minf.stbl.stsd.entries;
    const el = trak.edts?.elst?.entries?.find((e: any) => e.media_time >= 0);
    shift = el ? el.media_time / trak.mdia.mdhd.timescale : 0;
    track = {
      codec: v.codec, codecs: entries.map((e: any) => e.getCodec?.() ?? v.codec), width: v.video.width, height: v.video.height,
      descriptions: entries.map(descOf), samples: [], file, lazy, fragmented,
    };
    if (lazy) {
      for (const s of trak.samples) track.samples.push({ data: null, off: s.offset, size: s.size, ts: s.cts / s.timescale - shift, dur: s.duration / s.timescale, key: s.is_sync, desc: s.description_index ?? 0 });
    } else { mp4.setExtractionOptions(v.id, null, { nbSamples: Infinity }); mp4.start(); }
  };
  mp4.onSamples = (_id: number, _u: unknown, ss: any[]) => {
    for (const s of ss) track!.samples.push({ data: s.data, off: 0, size: s.size, ts: s.cts / s.timescale - shift, dur: s.duration / s.timescale, key: s.is_sync, desc: s.description_index ?? 0 });
  };
  if (lazy) {
    // mp4box wants contiguous input: hand it ftyp+moov back to back (sample offsets come from stco/co64,
    // which are absolute file positions, so skipping mdat doesn't change them)
    const parts = await Promise.all(boxes.filter(b => b.type === 'ftyp' || b.type === 'moov').map(b => file.slice(b.start, b.start + b.size).arrayBuffer()));
    const buf = await new Blob(parts).arrayBuffer() as ArrayBuffer & { fileStart: number };
    buf.fileStart = 0; mp4.appendBuffer(buf);
  } else {
    const buf = await file.arrayBuffer() as ArrayBuffer & { fileStart: number };
    buf.fileStart = 0; mp4.appendBuffer(buf);
  }
  mp4.flush();
  if (err) throw err;
  if (!track) throw new Error('could not parse ' + file.name);
  return track;
}

/** True if an AVCC/HVCC length-prefixed sample contains an IDR / IRAP picture. */
function isKey(data: Uint8Array, hevc: boolean, nalLen = 4): boolean {
  let p = 0;
  while (p + nalLen < data.length) {
    let len = 0; for (let k = 0; k < nalLen; k++) len = len * 256 + data[p + k];
    const h = data[p + nalLen];
    if (hevc) { const t = (h >> 1) & 63; if (t >= 16 && t <= 23) return true; }
    else { const t = h & 31; if (t === 5) return true; }
    if (len <= 0) break; p += nalLen + len;
  }
  return false;
}

export interface MemStats { loads: number; bytesRead: number; peakResident: number; resident: number; }

/**
 * Sequential frame source with backpressure; frameAt(t) returns the latest frame with ts <= t.
 * Sample bytes are read from the file `chunkFrames` at a time and released right after decoding, so
 * memory stays bounded for long clips. Keyframes are detected from the bitstream, decoding always
 * starts on a keyframe, a change of sample description (parameter-set change) reconfigures the
 * decoder at the next keyframe, and on a decoder error the decoder is rebuilt and resumes.
 */
class FrameSource {
  private q: VideoFrame[] = [];
  private cur: VideoFrame | null = null;
  private next = 0; private loaded = 0; private loading: Promise<void> | null = null;
  private dec!: VideoDecoder;
  private waiter: (() => void) | null = null;
  private needKey = true; private flushed = false; private failures = 0; private desc = -1;
  private keys: boolean[] = [];
  private live = new Map<ArrayBuffer, number>(); // chunk buffer -> samples still referencing it
  constructor(private tr: Track, private name: string, private chunkFrames: number, private qmax: number, private mem: MemStats) {
    this.loaded = tr.lazy ? 0 : tr.samples.length;
    for (let i = 0; i < this.loaded; i++) this.markKey(i);
    this.make(tr.samples[0]?.desc ?? 0);
  }
  private hevc(d: number) { return /^(hvc1|hev1)/.test(this.tr.codecs[d] ?? this.tr.codec); }
  private markKey(i: number) {
    const s = this.tr.samples[i], h = this.hevc(s.desc), nl = h ? 4 : ((this.tr.descriptions[s.desc]?.[4] ?? 3) & 3) + 1;
    this.keys[i] = !!s.data && isKey(s.data, h, nl);
  }
  private make(d: number) {
    this.dec = new VideoDecoder({
      output: f => { this.q.push(f); this.waiter?.(); },
      error: e => { console.warn(`[TeslaCutCam] ${this.name} decoder error, resyncing at next keyframe:`, e); this.failures++; this.waiter?.(); },
    });
    this.configure(d);
  }
  private configure(d: number) {
    this.desc = d;
    this.dec.configure({ codec: this.tr.codecs[d] ?? this.tr.codec, codedWidth: this.tr.width, codedHeight: this.tr.height, description: this.tr.descriptions[d] ?? this.tr.descriptions[0] } as VideoDecoderConfig);
    this.needKey = true; this.flushed = false;
  }
  /** read the next chunk of sample bytes from disk */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    const S = this.tr.samples, a = this.loaded, b = Math.min(S.length, a + this.chunkFrames);
    if (a >= b) return Promise.resolve();
    this.loading = (async () => {
      let lo = Infinity, hi = 0;
      for (let i = a; i < b; i++) { lo = Math.min(lo, S[i].off); hi = Math.max(hi, S[i].off + S[i].size); }
      const ab = await this.tr.file.slice(lo, hi).arrayBuffer(), u8 = new Uint8Array(ab);
      for (let i = a; i < b; i++) { S[i].data = u8.subarray(S[i].off - lo, S[i].off - lo + S[i].size); this.markKey(i); }
      this.live.set(ab, b - a);
      this.mem.loads++; this.mem.bytesRead += ab.byteLength; this.mem.resident += ab.byteLength;
      this.mem.peakResident = Math.max(this.mem.peakResident, this.mem.resident);
      this.loaded = b; this.loading = null;
    })();
    return this.loading;
  }
  private release(i: number) {
    const s = this.tr.samples[i]; if (!this.tr.lazy || !s.data) return;
    const ab = s.data.buffer as ArrayBuffer; s.data = null;
    const n = (this.live.get(ab) ?? 1) - 1;
    if (n <= 0) { this.live.delete(ab); this.mem.resident -= ab.byteLength; } else this.live.set(ab, n);
  }
  private feed() {
    if (this.dec.state === 'closed') {
      if (this.failures > 20) throw new Error(`${this.name}: video could not be decoded`);
      this.make(this.desc);
    }
    while (this.next < this.loaded && this.dec.decodeQueueSize < this.qmax && this.q.length < this.qmax) {
      const i = this.next++, s = this.tr.samples[i];
      if (s.desc !== this.desc) { if (!this.keys[i]) { this.release(i); continue; } this.configure(s.desc); } // parameter-set change
      if (this.needKey && !this.keys[i]) { this.release(i); continue; }
      this.needKey = false;
      this.dec.decode(new EncodedVideoChunk({ type: this.keys[i] ? 'key' : 'delta', timestamp: Math.round(s.ts * 1e6), duration: Math.round(s.dur * 1e6), data: s.data! }));
      this.release(i);
    }
    if (this.next >= this.tr.samples.length && !this.flushed && this.dec.state === 'configured') {
      this.flushed = true;
      this.dec.flush().catch(() => {}).then(() => this.waiter?.());
    }
  }
  private done() { return this.next >= this.tr.samples.length && (this.flushed || this.dec.state === 'closed') && this.dec.decodeQueueSize === 0; }
  private async pull(): Promise<VideoFrame | null> {
    for (;;) {
      if (this.q.length) return this.q.shift()!;
      if (this.done()) { await new Promise(r => setTimeout(r, 0)); if (this.q.length) continue; return null; }
      if (this.next >= this.loaded - Math.min(8, this.chunkFrames >> 2) && this.loaded < this.tr.samples.length) {
        const p = this.load(); if (this.next >= this.loaded) await p;
      }
      this.feed();
      if (this.q.length) continue;
      await new Promise<void>(r => { this.waiter = r; setTimeout(r, 30); });
    }
  }
  async frameAt(t: number): Promise<VideoFrame | null> {
    const us = t * 1e6 + 1000;
    for (;;) {
      if (this.cur && this.cur.timestamp + (this.cur.duration ?? 0) > us) break;
      const peek = this.q[0] ?? await this.pull().then(f => { if (f) this.q.unshift(f); return f; });
      if (!peek) break;
      if (peek.timestamp > us && this.cur) break;
      this.q.shift(); this.cur?.close(); this.cur = peek;
    }
    return this.cur;
  }
  close() {
    this.cur?.close(); this.q.forEach(f => f.close()); if (this.dec.state !== 'closed') this.dec.close();
    for (const ab of this.live.keys()) this.mem.resident -= ab.byteLength; this.live.clear();
  }
}

/** One source range in the output (an event trimmed to [from,to)). Several parts = combined video. */
export interface Part {
  event: TeslaEvent; telemetry: (Telemetry | null)[]; segStarts: number[]; from: number; to: number; mode: Mode;
  place: (seg: number, i: number) => string;
  /** playback-rate multiplier at event time t (1 = normal, 0.25 = 4x slow motion) */
  rate?: (t: number) => number;
  trail?: Trail | null;
}
export interface ExportOpts {
  /** cameras to fisheye-correct (see defish.ts) */
  defish?: string[];
  parts: Part[]; layout: Layout; main: Camera; overlay: OverlayOpts; hud: boolean;
  width: number; height: number; bitrate: number;
  chunkSec: number; queue: number;
  stab?: StabOpts | null;
  title?: CardOpts | null; end?: CardOpts | null; logo?: ImageBitmap | null;
  sink?: FileSystemWritableFileStream | null;
  onProgress: (p: number, msg?: string) => void; signal: AbortSignal;
}
export interface ExportResult { blob: Blob | null; bytes: number; frames: number; seconds: number; chunks: number; mem: MemStats; stab?: string; }

export async function exportVideo(o: ExportOpts): Promise<ExportResult> {
  const W = o.width & ~1, H = o.height & ~1;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  // ---- single output file: fragmented MP4, appended sequentially ----
  let blobs: Blob[] = [], parts: Uint8Array[] = [], bytes = 0, writeChain: Promise<unknown> = Promise.resolve(), writeErr: unknown = null;
  const target = new StreamTarget({
    onData: (data, pos) => {
      const copy = data.slice(); bytes = Math.max(bytes, pos + copy.byteLength);
      if (o.sink) writeChain = writeChain.then(() => o.sink!.write({ type: 'write', position: pos, data: copy })).catch(e => { writeErr = e; });
      else parts.push(copy);
    },
  });
  const consolidate = () => { if (parts.length) { blobs.push(new Blob(parts as BlobPart[])); parts = []; } };
  const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: 90000 /* = mp4 timescale (ticks/s): ms-aligned timestamps map to whole ticks, so ~36 fps VFR Tesla footage never collides */ }, fastStart: 'fragmented', minFragmentDuration: 1 });
  let encErr: unknown = null;
  // Decode timestamps: the i-th chunk out of the encoder gets the i-th frame time we fed in (frames are fed in
  // presentation order with strictly increasing, ms-aligned timestamps). Encoders that reorder (B-frames, e.g.
  // Firefox) then get a signed composition offset instead of tripping the muxer's monotonic-DTS check.
  const fed: number[] = []; let outIdx = 0;
  const enc = new VideoEncoder({ output: (c, m) => { const dts = fed[outIdx++] ?? c.timestamp; muxer.addVideoChunk(c, m, c.timestamp, c.timestamp - dts); }, error: e => { encErr = e; } });
  const cfg: VideoEncoderConfig = { codec: W * H > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028', width: W, height: H, bitrate: o.bitrate, framerate: 30, hardwareAcceleration: 'no-preference', latencyMode: 'realtime' /* no B-frames: some encoders (Firefox) reorder otherwise, and the muxer needs decode order == presentation order */ };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) delete cfg.latencyMode;
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg.codec = 'avc1.42E01F';
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error(`This browser cannot encode H.264 at ${W}×${H}. Try a lower resolution or Chrome/Edge.`);
  enc.configure(cfg);

  const mem: MemStats = { loads: 0, bytesRead: 0, peakResident: 0, resident: 0 };
  let outT = 0, frameNo = 0, lastTs = -1000, chunks = 0;
  const emit = async (dur: number) => {
    if (encErr) throw encErr;
    if (writeErr) throw writeErr;
    const ts = Math.max(lastTs + 1000, Math.round(outT * 1e3) * 1000); lastTs = ts; // ms-aligned, strictly increasing
    const vf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(dur * 1e6) });
    fed.push(ts);
    enc.encode(vf, { keyFrame: frameNo % 60 === 0 });
    vf.close();
    outT += dur; frameNo++;
    while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
  };
  const card = async (c: CardOpts, bg: ImageBitmap | null) => {
    const n = Math.max(1, Math.round(c.duration * 30));
    for (let k = 0; k < n; k++) {
      if (o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = k / 30, fade = Math.min(1, t / 0.4, (c.duration - t) / 0.4);
      drawCard(ctx, W, H, c, o.logo ?? null, bg, Math.max(0, fade));
      await emit(1 / 30);
    }
  };
  const total = o.parts.reduce((a, p) => a + (p.to - p.from), 0) || 1;
  let doneIn = 0, titleDone = !o.title;
  if (o.defish) setDefish(o.defish);
  const stab = o.stab ? new Stabilizer(o.stab) : null;

  for (let pi = 0; pi < o.parts.length; pi++) {
    const P = o.parts[pi], ev = P.event, evCams = eventCams(ev);
    const main = evCams.includes(o.main) ? o.main : evCams.includes('front') ? 'front' : evCams[0];
    const cams: Camera[] = o.layout === 'single' ? [main] : evCams;
    let acc = 0;
    for (let si = 0; si < ev.segments.length; si++) {
      const segStart = P.segStarts[si], segEnd = P.segStarts[si + 1] ?? Infinity;
      if (segEnd <= P.from || segStart >= P.to) continue;
      const seg = ev.segments[si];
      const sources: Record<Camera, FrameSource> = {}, tracks: Record<Camera, Track> = {};
      const pre = o.parts.length > 1 ? `Event ${pi + 1}/${o.parts.length} · ` : '';
      o.onProgress(doneIn / total, `${pre}Reading clip ${si + 1}/${ev.segments.length} (${cams.filter(c => seg.files[c]).map(camLabel).join(', ')})…`);
      await Promise.all(cams.filter(c => seg.files[c]).map(async c => { tracks[c] = await demux(seg.files[c]!); }));
      const clock = tracks[main] ?? tracks.front ?? Object.values(tracks)[0];
      if (!clock) continue;
      const fps = clock.samples.length / Math.max(0.1, clock.samples.reduce((a, s) => a + s.dur, 0));
      const chunkFrames = Math.max(16, Math.round(o.chunkSec * fps));
      for (const c of Object.keys(tracks)) sources[c] = new FrameSource(tracks[c], c, chunkFrames, o.queue, mem);
      stab?.reset();
      const tel = P.telemetry[si];
      try {
        for (let k = 0; k < clock.samples.length; k++) {
          if (o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
          const s = clock.samples[k], abs = segStart + s.ts;
          if (k % chunkFrames === 0) { chunks++; consolidate(); }
          if (s.ts < 0) { await Promise.all(Object.values(sources).map(src => src!.frameAt(0))); continue; }
          if (abs < P.from) { await Promise.all(Object.values(sources).map(src => src!.frameAt(s.ts))); continue; }
          if (abs >= P.to) break;
          const frames: Record<Camera, VideoFrame> = {};
          for (const c of cams) { const f = await sources[c]?.frameAt(s.ts); if (f) frames[c] = f; }
          const xf: Record<Camera, Xf> = stab ? await stab.step(frames, main) : {};
          if (!titleDone) {
            compose(ctx, W, H, o.layout, main, frames, xf);
            const bg = o.title!.bg === 'blur' ? await createImageBitmap(canvas) : null;
            await card(o.title!, bg); bg?.close(); titleDone = true;
          }
          const [hx, hy, hw, hh] = compose(ctx, W, H, o.layout, main, frames, xf);
          const time = new Date(seg.start.getTime() + s.ts * 1000);
          const i = tel ? Math.min(tel.n - 1, Math.floor((s.ts / (tel.duration || clock.samples.length / 36)) * tel.n)) : 0;
          if (o.hud) {
            ctx.save(); ctx.translate(hx, hy);
            if (P.mode === 'sentry') {
              const inf = ev.info || {};
              drawSentryHud(ctx, hw, hh, time, { reason: inf.reason, camera: inf.camera, trigger: inf.timestamp ? new Date(inf.timestamp) : undefined, place: [inf.street, inf.city].filter(Boolean).join(', ') }, o.overlay);
            } else drawHud(ctx, hw, hh, { t: tel, i, time, place: P.place(si, i) }, o.overlay);
            if (o.overlay.map && P.trail) drawMapPanel(ctx, hw, hh, P.trail, abs, tel?.hasData ? tel.heading[i] : 0, o.overlay);
            ctx.restore();
          }
          // speed ramp: repeat frames so the output keeps the source frame rate while time slows down
          const rate = Math.max(0.05, Math.min(1, P.rate ? P.rate(abs) : 1));
          acc += 1 / rate; let n = Math.floor(acc + 1e-6); acc -= n;
          while (n-- > 0) await emit(s.dur);
          doneIn += s.dur;
          if (frameNo % 10 === 0) o.onProgress(Math.min(1, doneIn / total), `${pre}Encoding ${Math.round(Math.min(1, doneIn / total) * 100)}% · frame ${frameNo} · chunk ${chunks}`);
        }
      } finally { Object.values(sources).forEach(s => s!.close()); }
    }
  }
  if (o.end) { const bg = o.end.bg === 'blur' ? await createImageBitmap(canvas) : null; await card(o.end, bg); bg?.close(); }
  if (!frameNo) throw new Error('Nothing to export in the selected range.');
  await enc.flush(); enc.close();
  if (encErr) throw encErr;
  muxer.finalize();
  await writeChain; if (writeErr) throw writeErr;
  consolidate();
  stab?.close();
  o.onProgress(1);
  return { blob: o.sink ? null : new Blob(blobs, { type: 'video/mp4' }), bytes, frames: frameNo, seconds: outT, chunks, mem, stab: stab?.summary() };
}
