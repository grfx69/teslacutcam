import { parseTelemetry } from './sei';

self.onmessage = async (e: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = e.data;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t = parseTelemetry(buf);
    const transfer = [t.speed, t.pedal, t.steer, t.ax, t.ay, t.az, t.lat, t.lon, t.heading, t.gear, t.ap, t.flags].map(a => a.buffer);
    (self as unknown as Worker).postMessage({ id, t }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
