// Scans a user-picked folder (TeslaCam root, SavedClips, SentryClips, RecentClips
// or a single event folder) and groups clips into events -> segments -> cameras.

// Canonical camera ids. Tesla uses long names (front, back, left_repeater, ...); some
// builds/tools use short codes (f, b, l, r, bf, br, fw). Anything unknown is kept as-is.
export type Camera = string;
export const CAMERAS: Camera[] = ['front', 'front_wide', 'left_pillar', 'right_pillar', 'left_repeater', 'right_repeater', 'back'];
const ALIAS: Record<string, Camera> = {
  front: 'front', f: 'front', main: 'front',
  fw: 'front_wide', front_wide: 'front_wide', wide: 'front_wide', bumper: 'front_wide', front_bumper: 'front_wide', narrow: 'front_wide',
  back: 'back', b: 'back', rear: 'back',
  left_repeater: 'left_repeater', l: 'left_repeater', left: 'left_repeater', repeater_left: 'left_repeater',
  right_repeater: 'right_repeater', r: 'right_repeater', right: 'right_repeater', repeater_right: 'right_repeater',
  left_pillar: 'left_pillar', bf: 'left_pillar', pillar_left: 'left_pillar', left_bpillar: 'left_pillar', fl: 'left_pillar',
  right_pillar: 'right_pillar', br: 'right_pillar', pillar_right: 'right_pillar', right_bpillar: 'right_pillar', fr: 'right_pillar',
};
export const CAM_LABEL: Record<string, string> = {
  front: 'Front', front_wide: 'Front bumper', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater',
  left_pillar: 'Left pillar', right_pillar: 'Right pillar',
};
export const camLabel = (c: Camera) => CAM_LABEL[c] ?? c.replace(/_/g, ' ');
export function normCam(raw: string): Camera | null {
  const k = raw.toLowerCase().replace(/[- ]/g, '_');
  if (k === 'event') return null; // Tesla's pre-composited event.mp4 summary
  return ALIAS[k] ?? k;
}
/** cameras present in an event, in display order */
export function eventCams(e: TeslaEvent): Camera[] {
  const set = new Set<Camera>(); e.segments.forEach(s => Object.keys(s.files).forEach(c => set.add(c)));
  return [...CAMERAS.filter(c => set.has(c)), ...[...set].filter(c => !CAMERAS.includes(c)).sort()];
}

export interface Segment { stamp: string; start: Date; files: Record<Camera, File>; }
export interface TeslaEvent {
  id: string; name: string; kind: string; start: Date;
  segments: Segment[]; info?: Record<string, string>; thumb?: File;
}

export interface Entry { path: string; file: File; }

const CLIP_RE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})[-_]([a-z_]+?)(?:[-_]\d+)?\.mp4$/i;

function stampToDate(s: string): Date {
  const [d, t] = s.split('_');
  return new Date(`${d}T${t.replace(/-/g, ':')}`);
}

export async function* walkHandle(dir: FileSystemDirectoryHandle, prefix = ''): AsyncGenerator<Entry> {
  // @ts-ignore values() is part of the File System Access API
  for await (const h of dir.values()) {
    const p = prefix + h.name;
    if (h.kind === 'directory') yield* walkHandle(h as FileSystemDirectoryHandle, p + '/');
    else if (/\.(mp4|json|png)$/i.test(h.name)) yield { path: p, file: await (h as FileSystemFileHandle).getFile() };
  }
}

export async function buildLibrary(entries: Entry[], onStep?: (msg: string) => void): Promise<TeslaEvent[]> {
  onStep?.(`Grouping ${entries.length} files…`);
  const groups = new Map<string, { kind: string; files: Entry[] }>();
  for (const e of entries) {
    const parts = e.path.split('/');
    const dir = parts.slice(0, -1).join('/');
    const kind = /SentryClips/i.test(e.path) ? 'Sentry' : /SavedClips/i.test(e.path) ? 'Saved' : /RecentClips/i.test(e.path) ? 'Recent' : 'Clips';
    if (!groups.has(dir)) groups.set(dir, { kind, files: [] });
    groups.get(dir)!.files.push(e);
  }
  const events: TeslaEvent[] = [];
  for (const [dir, g] of groups) {
    const segs = new Map<string, Segment>();
    let info: Record<string, string> | undefined, thumb: File | undefined;
    for (const { file } of g.files) {
      const m = file.name.match(CLIP_RE);
      if (m) {
        const s = segs.get(m[1]) ?? { stamp: m[1], start: stampToDate(m[1]), files: {} };
        const cam = normCam(m[2]);
        if (cam) { s.files[cam] = file; segs.set(m[1], s); }
      } else if (/event\.json$/i.test(file.name)) {
        onStep?.('Reading event.json…');
        try { info = JSON.parse(await file.text()); } catch { /* ignore */ }
      } else if (/thumb\.png$/i.test(file.name)) thumb = file;
    }
    if (!segs.size) continue;
    const segments = [...segs.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
    if (g.kind === 'Recent' || g.kind === 'Clips' && !info) {
      // flat folder: split into drives wherever there's a gap > 90 s
      let cur: Segment[] = [];
      const flush = () => { if (cur.length) events.push(mk(dir, g.kind, cur)); cur = []; };
      for (const s of segments) {
        const prev = cur[cur.length - 1];
        if (prev && s.start.getTime() - prev.start.getTime() > 90_000) flush();
        cur.push(s);
      }
      flush();
    } else events.push({ ...mk(dir, g.kind, segments), info, thumb });
  }
  return events.sort((a, b) => b.start.getTime() - a.start.getTime());
}

function mk(dir: string, kind: string, segments: Segment[]): TeslaEvent {
  const start = segments[0].start;
  return { id: dir + '|' + segments[0].stamp, name: start.toLocaleString(), kind, start, segments };
}
