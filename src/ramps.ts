// Speed ramping: find interesting moments in the telemetry and slow the export down around them.
import type { Telemetry } from './sei';
import { accel } from './overlay';

export interface RampOpts {
  on: boolean; brake: boolean; accel: boolean; lateral: boolean; vertical: boolean; fsd: boolean; sentry: boolean;
  threshold: number; // g
  factor: number;    // 0.25 .. 1
  ramp: number;      // seconds to ease in/out
  hold: number;      // seconds at full slow-down
}
export const defaultRamp: RampOpts = { on: false, brake: true, accel: false, lateral: true, vertical: true, fsd: true, sentry: true, threshold: 0.3, factor: 0.25, ramp: 0.6, hold: 1.5 };
export interface Trigger { t: number; type: 'brake' | 'accel' | 'lateral' | 'vertical' | 'fsd' | 'sentry'; v: number; }
export const TRIGGER_LABEL: Record<Trigger['type'], string> = { brake: 'Hard braking', accel: 'Rapid acceleration', lateral: 'Sharp turn', vertical: 'Bump', fsd: 'FSD disengaged', sentry: 'Sentry trigger' };
const G = 9.80665;

export function findTriggers(tel: (Telemetry | null)[], segStarts: number[], o: RampOpts, info?: Record<string, string>, start?: Date): Trigger[] {
  const out: Trigger[] = [], last: Record<string, number> = {};
  const add = (type: Trigger['type'], t: number, v: number) => { if (t - (last[type] ?? -1e9) > Math.max(3, o.hold + 2 * o.ramp)) { out.push({ t, type, v }); last[type] = t; } };
  tel.forEach((T, si) => {
    if (!T?.hasData) return;
    const fps = T.n / Math.max(0.1, T.duration), win = Math.max(1, Math.round(fps * 0.15));
    const zs = [...T.az].sort((a, b) => a - b), zmed = zs[zs.length >> 1] ?? 0;
    for (let i = 0; i < T.n; i++) {
      const t = segStarts[si] + i / fps, [lo, la] = accel(T, i, win);
      if (o.brake && -lo / G > o.threshold && T.speed[i] > 2) add('brake', t, -lo / G);
      if (o.accel && lo / G > o.threshold) add('accel', t, lo / G);
      if (o.lateral && Math.abs(la) / G > o.threshold) add('lateral', t, Math.abs(la) / G);
      if (o.vertical && Math.abs(T.az[i] - zmed) / G > o.threshold * 1.5 && T.speed[i] > 2) add('vertical', t, Math.abs(T.az[i] - zmed) / G);
      if (o.fsd && i > 0 && T.ap[i - 1] === 1 && T.ap[i] !== 1) add('fsd', t, 1);
    }
  });
  if (o.sentry && info?.timestamp && start) {
    const t = (new Date(info.timestamp).getTime() - start.getTime()) / 1000;
    if (t >= 0) out.push({ t, type: 'sentry', v: 1 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** playback rate at time t: factor inside the hold window, eased (smoothstep) over `ramp` seconds */
export function rateAt(trig: Trigger[], o: RampOpts, t: number): number {
  let r = 1;
  for (const g of trig) {
    const d = Math.abs(t - g.t) - o.hold / 2;
    if (d > o.ramp) continue;
    const u = d <= 0 ? 0 : d / Math.max(0.01, o.ramp), e = u * u * (3 - 2 * u);
    r = Math.min(r, o.factor + (1 - o.factor) * e);
  }
  return r;
}
