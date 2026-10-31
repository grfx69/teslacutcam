// Fisheye / barrel "skew" correction for Tesla's wide cameras (rear, pillars, repeaters).
// Radial model from the original TeslaHUD: src = c + (1 + k1 r^2 + k2 r^4) * off,
// with r normalised to the half diagonal. One shared WebGL canvas per source size; the corrected
// frame is drawn straight into the 2D canvas, so it is reused across cameras within a frame.
export const DEFISH_CAMS = ['back', 'left_pillar', 'left_repeater', 'right_pillar', 'right_repeater'];
// Per-camera strength. The rear is a strong fisheye; pillars/repeaters are only mildly curved, so they
// get a much lighter (optional) correction. 'scale' zooms back out so the full width is kept at
// mid-height (only small corner trims) instead of the old crop-heavy mapping.
const RS = 16 * 16 / (16 * 16 + 9 * 9); // r^2 at the middle of a 16:9 side edge
const mk = (k1: number, k2: number) => ({ k1, k2, scale: 1 / (1 + k1 * RS + k2 * RS * RS) });
export const DEFISH_PARAMS: Record<string, { k1: number; k2: number; scale: number }> = {
  back: mk(-0.18, -0.03),
  left_pillar: mk(-0.05, 0), right_pillar: mk(-0.05, 0),
  left_repeater: mk(-0.05, 0), right_repeater: mk(-0.05, 0),
};
const VS = `attribute vec2 aPos;varying vec2 vUv;void main(){vUv=vec2(aPos.x*.5+.5,.5-aPos.y*.5);gl_Position=vec4(aPos,0.,1.);}`;
const FS = `precision highp float;varying vec2 vUv;uniform sampler2D uTex;uniform vec2 uRes;uniform float uK1,uK2,uS;
void main(){vec2 c=vec2(.5);vec2 off=(vUv-c)*uRes;float r2=dot(off,off)/(dot(uRes,uRes)*.25);
vec2 s=c+(1.+uK1*r2+uK2*r2*r2)*uS*off/uRes;
if(s.x<0.||s.x>1.||s.y<0.||s.y>1.){gl_FragColor=vec4(0.,0.,0.,1.);return;}gl_FragColor=texture2D(uTex,s);}`;

let enabled = new Set<string>();
export const setDefish = (cams: Iterable<string>) => { enabled = new Set(cams); };
export const getDefish = () => new Set(enabled);
export const defishOn = (cam: string) => enabled.has(cam);

interface R { cv: OffscreenCanvas | HTMLCanvasElement; gl: WebGLRenderingContext; res: WebGLUniformLocation; k1: WebGLUniformLocation; k2: WebGLUniformLocation; sc: WebGLUniformLocation; }
let r: R | null = null, failed = false;
function init(): R | null {
  if (r || failed) return r;
  try {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('no webgl');
    const p = gl.createProgram()!;
    for (const [t, s] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(p, sh); }
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    r = { cv, gl, res: gl.getUniformLocation(p, 'uRes')!, k1: gl.getUniformLocation(p, 'uK1')!, k2: gl.getUniformLocation(p, 'uK2')!, sc: gl.getUniformLocation(p, 'uS')! };
  } catch (e) { failed = true; console.warn('Fisheye correction unavailable (WebGL):', e); }
  return r;
}
/** Returns a canvas holding the corrected frame (valid until the next call), or null to draw the original. */
export function defish(src: TexImageSource, w: number, h: number, cam = 'back'): OffscreenCanvas | HTMLCanvasElement | null {
  const R = init(); if (!R || !w || !h) return null;
  const { cv, gl } = R;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); gl.uniform2f(R.res, w, h); }
  const P = DEFISH_PARAMS[cam] ?? DEFISH_PARAMS.back; gl.uniform1f(R.k1, P.k1); gl.uniform1f(R.k2, P.k2); gl.uniform1f(R.sc, P.scale);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return null; }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return cv;
}
