// "Front + pillars stitched": the front camera is drawn in full and unwarped in the middle of a wide virtual
// canvas; each B-pillar camera is mapped next to it with a perspective warp (a homography given by four corner
// pins, in units of the front frame: x 0..1 = front width, y 0..1 = front height). The pins are chosen so the
// curbs / barrier / lane lines meet the front's at the seam and the outer edge is taller (as in the mockups).
// Rendered per frame in one WebGL pass (inverse homography per pixel, fisheye term for the pillars, narrow
// cross-fade where the pillar slides under the front's edge), then scaled to fit the view / export.
export type Pin = [number, number];
export interface Pins { tl: Pin; tr: Pin; br: Pin; bl: Pin; lens: number; rot?: number; mx?: number; my?: number; sc?: number; }
export const P3_CAMS = ['left_pillar', 'front', 'right_pillar'] as const;
export const P5_CAMS = ['left_repeater', 'left_pillar', 'front', 'right_pillar', 'right_repeater'] as const;
/** defaults fitted on the 2026-05-06 07:23:49 HW4 clip (barrier top/base, lane edge, guardrail matched at each seam) */
export const P3_DEFAULTS: Record<string, Pins> = {
  left_pillar: { tl: [-0.87, 0.094], tr: [0.0276, 0.0816], br: [0.0276, 0.9516], bl: [-0.87, 1.294], lens: 0.06, rot: 0 },
  right_pillar: { tl: [0.9724, 0.109], tr: [1.87, 0.059], br: [1.87, 1.259], bl: [0.9724, 0.979], lens: 0.06, rot: 0 },
  left_repeater: { tl: [-1.69, -0.275], tr: [-0.84, -0.191], br: [-0.84, 0.922], bl: [-1.69, 1.005], lens: 0.06, rot: 15 },
  right_repeater: { tl: [1.84, -0.109], tr: [2.69, -0.199], br: [2.69, 1.181], bl: [1.84, 1.091], lens: 0.06, rot: -15 },
};
const KEY = 'tcc.pano3v1';
let cache: Record<string, Partial<Pins>> | null = null;
const load = () => { if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { cache = {}; } } return cache!; };
export const p3Pins = (cam: string): Pins => ({ ...P3_DEFAULTS[cam], ...(load()[cam] ?? {}) } as Pins);
export function setP3Pins(cam: string, v: Partial<Pins> | null) {
  const a = load(); if (v) a[cam] = { ...a[cam], ...v }; else delete a[cam];
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* */ }
}
/** whole pin set (all cameras + '_fe' blend) for presets */
export const p3All = () => JSON.parse(JSON.stringify(load()));
export function setP3All(v: Record<string, Partial<Pins>>) { cache = JSON.parse(JSON.stringify(v || {})); try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* */ } }
export const p3Blend = () => +((load() as any)._fe?.v ?? 0.04);
export const setP3Blend = (v: number) => { const a = load() as any; a._fe = { v }; try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* */ } };
const PK = 'tcc.p3presets', AK = 'tcc.p3active';
export const p3Presets = (): Record<string, any> => { try { return JSON.parse(localStorage.getItem(PK) || '{}'); } catch { return {}; } };
export const p3Active = () => localStorage.getItem(AK) || '';
export function savePreset(name: string) { const a = p3Presets(); a[name] = p3All(); localStorage.setItem(PK, JSON.stringify(a)); localStorage.setItem(AK, name); }
export function loadPreset(name: string) { const a = p3Presets()[name]; if (!a) return false; setP3All(a); localStorage.setItem(AK, name); return true; }
export function deletePreset(name: string) { const a = p3Presets(); delete a[name]; localStorage.setItem(PK, JSON.stringify(a)); if (p3Active() === name) localStorage.removeItem(AK); }
export function importPresets(j: any) { const a = { ...p3Presets(), ...(j.presets || {}) }; localStorage.setItem(PK, JSON.stringify(a)); if (j.current) setP3All(j.current); if (j.active) localStorage.setItem(AK, j.active); }
export const exportPresets = () => ({ app: 'teslacutcam', kind: 'stitch-presets', version: 1, active: p3Active(), current: p3All(), presets: p3Presets() });
export const resetP3 = () => { cache = {}; try { localStorage.removeItem(KEY); localStorage.removeItem(AK); } catch { /* */ } };
/** pins with the whole-camera Move X/Y applied (shape unchanged) */
export const p3Eff = (cam: string): Pins => { const p = p3Pins(cam), dx = p.mx || 0, dy = p.my || 0; const m = (q: Pin): Pin => [q[0] + dx, q[1] + dy]; return { ...p, tl: m(p.tl), tr: m(p.tr), br: m(p.br), bl: m(p.bl) }; };
/** front rect in front units: [x0, y0, w, h] (Move X/Y + Size about its centre; always the full frame) */
export const p3Front = (): [number, number, number, number] => { const f = (load().front || {}) as Partial<Pins>, sc = f.sc ?? 1; return [(f.mx || 0) + 0.5 - sc / 2, (f.my || 0) + 0.5 - sc / 2, sc, sc]; };
const sides = (n: 3 | 5) => (n === 5 ? P5_CAMS : P3_CAMS).filter(c => c !== 'front');

const FRONT_AR = 1876 / 2896; // HW4 front h/w (others are scaled to it)
/** canvas extent in front units (x0,x1,y0,y1) */
export function p3Extent(has: (c: string) => boolean = () => true, n: 3 | 5 = 3) {
  const F = p3Front(); let x0 = F[0], x1 = F[0] + F[2], y0 = F[1], y1 = F[1] + F[3];
  for (const c of sides(n)) {
    if (!has(c)) continue;
    const p = p3Eff(c);
    for (const [x, y] of [p.tl, p.tr, p.br, p.bl]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x0, x1, y0, y1, aspect: (y1 - y0) * FRONT_AR / (x1 - x0) };
}
export const p3Aspect = (n: 3 | 5 = 3) => p3Extent(undefined, n).aspect;
/** canvas rects per camera (for click-to-expand), split at the seams */
export function p3Regions(W: number, H: number, has: (c: string) => boolean = () => true, n: 3 | 5 = 3): { cam: string; r: [number, number, number, number] }[] {
  const e = p3Extent(has, n), X = (x: number) => (x - e.x0) / (e.x1 - e.x0) * W, Y = (y: number) => (y - e.y0) / (e.y1 - e.y0) * H;
  const out: { cam: string; r: [number, number, number, number] }[] = [];
  const inner = (c: string) => { const p = p3Eff(c); return c.startsWith('left') ? Math.max(p.tr[0], p.br[0]) : Math.min(p.tl[0], p.bl[0]); };
  const outer = (c: string) => { const p = p3Eff(c); return c.startsWith('left') ? Math.min(p.tl[0], p.bl[0]) : Math.max(p.tr[0], p.br[0]); };
  const F0 = p3Front();
  for (const side of ['left', 'right']) {
    const pl = side + '_pillar', rp = side + '_repeater', L = side === 'left';
    const F = p3Front(); let edge = L ? F[0] : F[0] + F[2];
    if (has(pl)) { const o = outer(pl); out.push({ cam: pl, r: L ? [X(o), 0, X(edge) - X(o), H] : [X(edge), 0, X(o) - X(edge), H] }); edge = o; }
    if (n === 5 && has(rp)) out.push({ cam: rp, r: L ? [0, 0, X(edge), H] : [X(edge), 0, W - X(edge), H] });
  }
  void inner;
  out.push({ cam: 'front', r: [X(F0[0]), Y(F0[1]), X(F0[0] + F0[2]) - X(F0[0]), Y(F0[1] + F0[3]) - Y(F0[1])] });
  return out;
}

// square (0..1) -> quad homography, row-major 3x3
function sq2quad(q: Pin[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q; // tl, tr, br, bl
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1, g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
}
const mul = (A: number[], B: number[]) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
/** uv -> canvas: rotate the source about its centre (aspect-correct, degrees), then the corner-pin homography */
function fwd(p: Pins, ar: number) {
  const t = (p.rot || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const R = mul(mul([1, 0, .5, 0, 1, .5, 0, 0, 1], [1, 0, 0, 0, 1 / ar, 0, 0, 0, 1]), mul([c, -s, 0, s, c, 0, 0, 0, 1], mul([1, 0, 0, 0, ar, 0, 0, 0, 1], [1, 0, -.5, 0, 1, -.5, 0, 0, 1])));
  return mul(sq2quad([p.tl, p.tr, p.br, p.bl]), R);
}
/** canvas point (front units) -> pillar uv, for tests / tools */
export function p3Inverse(cam: string) { return inv3(fwd(p3Eff(cam), FRONT_AR)); }

const VS = `attribute vec2 aPos;varying vec2 vUv;void main(){vUv=vec2(aPos.x*.5+.5,.5-aPos.y*.5);gl_Position=vec4(aPos,0.,1.);}`;
const FS = `precision highp float;varying vec2 vUv;
uniform sampler2D t0,t1,t2,t3,t4;uniform mat3 h0,h1,h3,h4;uniform vec4 ext,lens;uniform float has[5];uniform float fe;uniform vec4 fr;
vec2 undist(vec2 uv,float k){vec2 n=(uv-.5)*vec2(1.,.648);float r2=dot(n,n)/.355;n*=1.-k*r2;return n/vec2(1.,.648)+.5;}
void lay(inout vec3 col,inout float al,sampler2D t,mat3 H,vec2 p,float k,float h){if(h<.5)return;vec3 q=H*vec3(p,1.);if(q.z<=0.)return;vec2 uv=q.xy/q.z;
  if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)return;float e=min(min(uv.x,1.-uv.x)/fe,1.);float w=al>0.?e:1.;
  col=mix(col,texture2D(t,clamp(undist(uv,k),0.,1.)).rgb,w);al=max(al,w);}
void main(){vec2 p=vec2(mix(ext.x,ext.y,vUv.x),mix(ext.z,ext.w,vUv.y));vec3 col=vec3(0.);float al=0.;
  lay(col,al,t0,h0,p,lens.x,has[0]);lay(col,al,t4,h4,p,lens.w,has[4]);lay(col,al,t1,h1,p,lens.y,has[1]);lay(col,al,t3,h3,p,lens.z,has[3]);
  vec2 f=(p-fr.xy)/fr.zw;if(has[2]>.5&&f.x>=0.&&f.x<=1.&&f.y>=0.&&f.y<=1.){float e=min(f.x,1.-f.x);float wf=al>0.?clamp(e/(fe*.75),0.,1.):1.;col=mix(col,texture2D(t2,f).rgb,wf);al=1.;}
  gl_FragColor=vec4(col*al,1.);}`;

interface G { cv: OffscreenCanvas | HTMLCanvasElement; gl: WebGLRenderingContext; u: Record<string, WebGLUniformLocation>; tex: WebGLTexture[]; }
let g: G | null = null, failed = false;
function init(): G | null {
  if (g || failed) return g;
  try {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('no webgl');
    const p = gl.createProgram()!;
    for (const [t, s] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(sh))); gl.attachShader(p, sh); }
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    const u: Record<string, WebGLUniformLocation> = {};
    for (const n of ['t0', 't1', 't2', 't3', 't4', 'h0', 'h1', 'h3', 'h4', 'ext', 'has', 'lens', 'fe', 'fr']) u[n] = gl.getUniformLocation(p, n)!;
    const tex = [0, 1, 2, 3, 4].map(i => {
      const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.uniform1i(u['t' + i], i); return t;
    });
    g = { cv, gl, u, tex };
  } catch (e) { failed = true; console.warn('Stitched panorama unavailable (WebGL):', e); }
  return g;
}
type Src = CanvasImageSource & ({ videoWidth: number; videoHeight: number } | { displayWidth: number; displayHeight: number });
const dims = (s: Src): [number, number] => 'videoWidth' in s ? [s.videoWidth, s.videoHeight] : [s.displayWidth, s.displayHeight];
const colMajor = (m: number[]) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
/** Render the stitched view at W×H (n = 3: front + pillars, 5: + repeaters); returns the canvas or null without WebGL. */
export function renderPano3(src: Record<string, Src | undefined>, W: number, H: number, n: 3 | 5 = 3) {
  const G = init(); if (!G) return null;
  const { gl, u, cv } = G;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  gl.viewport(0, 0, W, H);
  const has = [0, 0, 0, 0, 0], use = new Set<string>(n === 5 ? P5_CAMS : P3_CAMS);
  P5_CAMS.forEach((cam, i) => {
    const s = use.has(cam) ? src[cam] : undefined;
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, G.tex[i]);
    if (s) { const [w, h] = dims(s); if (w && h) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s as TexImageSource); has[i] = 1; } catch { /* not ready */ } } }
    if (cam !== 'front') gl.uniformMatrix3fv(u['h' + i], false, colMajor(inv3(fwd(p3Eff(cam), FRONT_AR))));
  });
  const e = p3Extent(c => use.has(c) && !!src[c], n);
  gl.uniform4f(u.ext, e.x0, e.x1, e.y0, e.y1); gl.uniform1fv(u.has, new Float32Array(has));
  const k = (c: string) => p3Pins(c).lens;
  gl.uniform4f(u.lens, k('left_repeater'), k('left_pillar'), k('right_pillar'), k('right_repeater')); gl.uniform1f(u.fe, Math.max(0.002, p3Blend())); gl.uniform4f(u.fr, ...p3Front());
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return cv;
}
