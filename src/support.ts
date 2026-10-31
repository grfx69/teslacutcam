// Browser capability detection.
export interface Support { webcodecs: boolean; offscreen: boolean; fsAccess: boolean; hevcDecode: boolean | null; browser: string; version: number; ok: boolean; message: string; }

export function browserInfo(): { browser: string; version: number } {
  const ua = navigator.userAgent;
  let m = ua.match(/Edg\/(\d+)/); if (m) return { browser: 'Edge', version: +m[1] };
  m = ua.match(/Firefox\/(\d+)/); if (m) return { browser: 'Firefox', version: +m[1] };
  m = ua.match(/Chrome\/(\d+)/); if (m) return { browser: 'Chrome', version: +m[1] };
  m = ua.match(/Version\/(\d+).*Safari/); if (m) return { browser: 'Safari', version: +m[1] };
  return { browser: 'Unknown', version: 0 };
}

export async function detectSupport(): Promise<Support> {
  const { browser, version } = browserInfo();
  const webcodecs = typeof (window as any).VideoDecoder === 'function' && typeof (window as any).VideoEncoder === 'function' && typeof (window as any).VideoFrame === 'function';
  const offscreen = typeof (window as any).OffscreenCanvas === 'function';
  const fsAccess = 'showDirectoryPicker' in window;
  let hevcDecode: boolean | null = null;
  if (webcodecs) { try { hevcDecode = !!(await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0', codedWidth: 1280, codedHeight: 960 })).supported; } catch { hevcDecode = false; } }
  const ok = webcodecs && offscreen;
  let message = '';
  if (!ok) message = `Export needs WebCodecs, which ${browser}${version ? ' ' + version : ''} doesn't provide. Viewing still works. For exporting, use Chrome or Edge (recommended)` +
    (browser === 'Firefox' ? `, or update Firefox to version 130 or newer.` : browser === 'Safari' ? '. Safari support is incomplete.' : '.');
  else if (browser === 'Firefox' && version < 130) message = `Firefox ${version} has incomplete WebCodecs support; update to Firefox 130+ or use Chrome/Edge.`;
  return { webcodecs, offscreen, fsAccess, hevcDecode, browser, version, ok, message };
}

/** Can this browser decode the given codec string at this size? */
export async function canDecode(codec: string, w: number, h: number): Promise<boolean> {
  try { return !!(await VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h })).supported; } catch { return false; }
}
