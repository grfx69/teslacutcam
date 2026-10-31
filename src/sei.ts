// Parser for Tesla dashcam per-frame telemetry.
// Tesla firmware (2025.x+) embeds a protobuf "SeiMetadata" message in an H.264
// SEI NAL unit before every frame of the front camera. Field numbers follow
// Tesla's published dashcam schema:
//  1 version, 2 gear_state, 3 frame_seq_no, 4 vehicle_speed_mps,
//  5 accelerator_pedal_position, 6 steering_wheel_angle, 7 blinker_on_left,
//  8 blinker_on_right, 9 brake_applied, 10 autopilot_state, 11 latitude_deg,
//  12 longitude_deg, 13 heading_deg, 14-16 linear_acceleration_mps2 x/y/z

export interface Telemetry {
  n: number;            // frame count
  duration: number;     // seconds
  speed: Float32Array;  // m/s
  pedal: Float32Array;  // 0..100
  steer: Float32Array;  // degrees
  ax: Float32Array; ay: Float32Array; az: Float32Array; // m/s^2
  lat: Float64Array; lon: Float64Array; heading: Float32Array;
  gear: Uint8Array;     // 0 park 1 drive 2 reverse 3 neutral
  ap: Uint8Array;       // 0 none 1 self-driving(FSD) 2 autosteer 3 TACC
  flags: Uint8Array;    // bit0 blink L, bit1 blink R, bit2 brake
  hasData: boolean;
}

type Fields = Record<number, number>;

function unescapeRbsp(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let o = 0, zeros = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (zeros >= 2 && v === 3) { zeros = 0; continue; }
    zeros = v === 0 ? zeros + 1 : 0;
    out[o++] = v;
  }
  return out.subarray(0, o);
}

function findMagic(b: Uint8Array): number {
  for (let i = 0; i + 4 <= b.length; i++)
    if (b[i] === 0x42 && b[i + 1] === 0x42 && b[i + 2] === 0x42 && b[i + 3] === 0x69) return i + 4;
  return -1;
}

function parseProto(b: Uint8Array, start: number): Fields | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f: Fields = {};
  let i = start;
  const varint = (): number => {
    let r = 0, mul = 1;
    for (;;) {
      if (i >= b.length) throw 0;
      const c = b[i++];
      r += (c & 127) * mul;
      if (!(c & 128)) return r;
      mul *= 128;
    }
  };
  try {
    while (i < b.length - 1) {
      const key = varint();
      const field = Math.floor(key / 8), wt = key & 7;
      if (field === 0) break;
      if (wt === 0) f[field] = varint();
      else if (wt === 1) { f[field] = dv.getFloat64(i, true); i += 8; }
      else if (wt === 5) { f[field] = dv.getFloat32(i, true); i += 4; }
      else if (wt === 2) { i += varint(); }
      else break;
    }
  } catch { /* truncated – keep what we have */ }
  return f;
}

/** Walk top-level boxes; return mdat ranges and the movie duration. */
function scanBoxes(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mdats: [number, number][] = [];
  let duration = 0;
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = buf.length - p;
    if (size < hdr) break;
    if (type === 'mdat') mdats.push([p + hdr, Math.min(buf.length, p + size)]);
    if (type === 'moov') {
      // find mvhd inside moov
      let q = p + 8;
      while (q + 8 < p + size) {
        const s = dv.getUint32(q);
        const t = String.fromCharCode(buf[q + 4], buf[q + 5], buf[q + 6], buf[q + 7]);
        if (t === 'mvhd') {
          const v = buf[q + 8];
          if (v === 1) duration = Number(dv.getBigUint64(q + 32)) / dv.getUint32(q + 28);
          else duration = dv.getUint32(q + 24) / dv.getUint32(q + 20);
          break;
        }
        if (s < 8) break;
        q += s;
      }
    }
    p += size;
  }
  return { mdats, duration };
}

export function parseTelemetry(buf: Uint8Array): Telemetry {
  const { mdats, duration } = scanBoxes(buf);
  const frames: (Fields | null)[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pending: Fields | null = null;
  let last: Fields | null = null;
  for (const [s, e] of mdats) {
    let p = s;
    while (p + 5 <= e) {
      const len = dv.getUint32(p);
      if (len <= 0 || p + 4 + len > e) break;
      const type = buf[p + 4] & 31;
      if (type === 6) {
        const nal = unescapeRbsp(buf.subarray(p + 5, p + 4 + len));
        const m = findMagic(nal);
        if (m >= 0) pending = parseProto(nal, m);
      } else if (type === 1 || type === 5) {
        const fr: Fields | null = pending || last;
        frames.push(fr);
        last = fr; pending = null;
      }
      p += 4 + len;
    }
  }
  const n = frames.length;
  const T: Telemetry = {
    n, duration, hasData: frames.some(Boolean),
    speed: new Float32Array(n), pedal: new Float32Array(n), steer: new Float32Array(n),
    ax: new Float32Array(n), ay: new Float32Array(n), az: new Float32Array(n),
    lat: new Float64Array(n), lon: new Float64Array(n), heading: new Float32Array(n),
    gear: new Uint8Array(n), ap: new Uint8Array(n), flags: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (!f) continue;
    T.speed[i] = f[4] ?? 0; T.pedal[i] = f[5] ?? 0; T.steer[i] = f[6] ?? 0;
    T.ax[i] = f[14] ?? 0; T.ay[i] = f[15] ?? 0; T.az[i] = f[16] ?? 0;
    T.lat[i] = f[11] ?? 0; T.lon[i] = f[12] ?? 0; T.heading[i] = f[13] ?? 0;
    T.gear[i] = f[2] ?? 0; T.ap[i] = f[10] ?? 0;
    T.flags[i] = (f[7] ? 1 : 0) | (f[8] ? 2 : 0) | (f[9] ? 4 : 0);
  }
  return T;
}
