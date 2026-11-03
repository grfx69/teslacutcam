// "Front + pillars stitched": the front camera is drawn in full and unwarped in the middle of a wide virtual
// canvas; each B-pillar camera is mapped next to it with a perspective warp (a homography given by four corner
// pins, in units of the front frame: x 0..1 = front width, y 0..1 = front height). The pins are chosen so the
// curbs / barrier / lane lines meet the front's at the seam and the outer edge is taller (as in the mockups).
// Rendered per frame in one WebGL pass (inverse homography per pixel, fisheye term for the pillars, narrow
// cross-fade where the pillar slides under the front's edge), then scaled to fit the view / export.
export type Pin = [number, number];
export interface Pins { tl: Pin; tr: Pin; br: Pin; bl: Pin; lens: number; }
export const P3_CAMS = ['left_pillar', 'front', 'right_pillar'] as const;
/** defaults fitted on the 2026-05-06 07:23:49 HW4 clip (barrier top/base and lane edge matched at both seams) */
export const P3_DEFAULTS: Record<string, Pins> = {
  left_pillar: { tl: [-0.87, 0.094], tr: [0.0276, 0.0816], br: [0.0276, 0.9516], bl: [-0.87, 1.294], lens: 0.06 },
  right_pillar: { tl: [0.9724, 0.109], tr: [1.87, 0.059], br: [1.87, 1.259], bl: [0.9724, 0.979], lens: 0.06 },
};
const KEY = 'tcc.pano3v1';
let cache: Record<string, Partial<Pins>> | null = null;
const load = () => { if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { cache = {}; } } return cache!; };
export const p3Pins = (cam: string): Pins => ({ ...P3_DEFAULTS[cam], ...(load()[cam] ?? {}) } as Pins);
export function setP3Pins(cam: string, v: Partial<Pins> | null) {
  const a = load(); if (v) a[cam] = { ...a[cam], ...v }; else delete a[cam];
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* */ }
}
export const resetP3 = () => { cache = {}; try { localStorage.removeItem(KEY); } catch { /* */ } };

const FRONT_AR = 1876 / 2896; // HW4 front h/w (others are scaled to it)
/** canvas extent in front units (x0,x1,y0,y1) */
export function p3Extent(has: (c: string) => boolean = () => true) {
  let x0 = 0, x1 = 1, y0 = 0, y1 = 1;
  for (const c of ['left_pillar', 'right_pillar']) {
    if (!has(c)) continue;
    const p = p3Pins(c);
    for (const [x, y] of [p.tl, p.tr, p.br, p.bl]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x0, x1, y0, y1, aspect: (y1 - y0) * FRONT_AR / (x1 - x0) };
}
export const p3Aspect = () => p3Extent().aspect;
/** canvas rects per camera (for click-to-expand): front on top, pillars outside it */
export function p3Regions(W: number, H: number, has: (c: string) => boolean = () => true): { cam: string; r: [number, number, number, number] }[] {
  const e = p3Extent(has), X = (x: number) => (x - e.x0) / (e.x1 - e.x0) * W, Y = (y: number) => (y - e.y0) / (e.y1 - e.y0) * H;
  const out: { cam: string; r: [number, number, number, number] }[] = [];
  if (has('left_pillar')) out.push({ cam: 'left_pillar', r: [0, 0, X(0), H] });
  if (has('right_pillar')) out.push({ cam: 'right_pillar', r: [X(1), 0, W - X(1), H] });
  out.push({ cam: 'front', r: [X(0), Y(0), X(1) - X(0), Y(1) - Y(0)] });
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
/** canvas point (front units) -> pillar uv, for tests / tools */
export function p3Inverse(cam: string) { return inv3(sq2quad(((p) => [p.tl, p.tr, p.br, p.bl])(p3Pins(cam)))); }

const VS = `attribute vec2 aPos;varying vec2 vUv;void main(){vUv=vec2(aPos.x*.5+.5,.5-aPos.y*.5);gl_Position=vec4(aPos,0.,1.);}`;
const FS = `precision highp float;varying vec2 vUv;
uniform sampler2D t0,t1,t2;uniform mat3 h0,h2;uniform vec4 ext;uniform vec3 has;uniform vec2 lens;uniform float fe,ar0,ar2;
vec2 undist(vec2 uv,float k,float ar){vec2 n=(uv-.5)*vec2(1.,ar);float r2=dot(n,n)/(.25+.25*ar*ar);n*=1.-k*r2;return n/vec2(1.,ar)+.5;}
vec4 side(sampler2D t,mat3 H,vec2 p,float k,float ar,out float w){vec3 q=H*vec3(p,1.);vec2 uv=q.xy/q.z;w=0.;if(q.z<=0.||uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)return vec4(0.);
  uv=undist(uv,k,ar);w=1.;return texture2D(t,clamp(uv,0.,1.));}
void main(){vec2 p=vec2(mix(ext.x,ext.y,vUv.x),mix(ext.z,ext.w,vUv.y));
  float w0,w2;vec4 a=side(t0,h0,p,lens.x,ar0,w0)*has.x,c=side(t2,h2,p,lens.y,ar2,w2)*has.z;w0*=has.x;w2*=has.z;
  vec3 col=(a.rgb*w0+c.rgb*w2)/max(w0+w2,1e-4);float al=max(w0,w2);
  if(has.y>0.&&p.x>=0.&&p.x<=1.&&p.y>=0.&&p.y<=1.){
    float e=min(p.x,1.-p.x);float wf=al>0.?clamp(e/fe,0.,1.):1.;col=mix(col,texture2D(t1,p).rgb,wf);al=1.;}
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
    for (const n of ['t0', 't1', 't2', 'h0', 'h2', 'ext', 'has', 'lens', 'fe', 'ar0', 'ar2']) u[n] = gl.getUniformLocation(p, n)!;
    const tex = [0, 1, 2].map(i => {
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
/** Render the stitched view at W×H; returns the canvas (valid until the next call) or null without WebGL. */
export function renderPano3(src: Record<string, Src | undefined>, W: number, H: number) {
  const G = init(); if (!G) return null;
  const { gl, u, cv } = G;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  gl.viewport(0, 0, W, H);
  const has = [0, 0, 0], ar = [FRONT_AR, FRONT_AR, FRONT_AR];
  P3_CAMS.forEach((cam, i) => {
    const s = src[cam];
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, G.tex[i]);
    if (s) { const [w, h] = dims(s); if (w && h) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s as TexImageSource); has[i] = 1; ar[i] = h / w; } catch { /* not ready */ } } }
  });
  const L = p3Pins('left_pillar'), R = p3Pins('right_pillar');
  gl.uniformMatrix3fv(u.h0, false, colMajor(inv3(sq2quad([L.tl, L.tr, L.br, L.bl]))));
  gl.uniformMatrix3fv(u.h2, false, colMajor(inv3(sq2quad([R.tl, R.tr, R.br, R.bl]))));
  const e = p3Extent(c => !!src[c]);
  gl.uniform4f(u.ext, e.x0, e.x1, e.y0, e.y1); gl.uniform3f(u.has, has[0], has[1], has[2]);
  gl.uniform2f(u.lens, L.lens, R.lens); gl.uniform1f(u.fe, 0.03); gl.uniform1f(u.ar0, ar[0]); gl.uniform1f(u.ar2, ar[2]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return cv;
}
