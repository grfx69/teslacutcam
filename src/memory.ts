// Memory-aware chunk planning for exports. Output is always ONE file; this only decides how many
// seconds of input are read and kept in memory at a time, and how deep the decoder queues are.
export type Perf = 'auto' | 'low' | 'high';
export interface RamInfo { gb: number; source: string; heapLimitMB?: number; heapUsedMB?: number; }

export function detectRam(): RamInfo {
  const sim = +(new URLSearchParams(location.search).get('ram') || localStorage.getItem('tcc.simRamGB') || 0);
  const pm = (performance as any).memory;
  const heap = pm ? { heapLimitMB: Math.round(pm.jsHeapSizeLimit / 2 ** 20), heapUsedMB: Math.round(pm.usedJSHeapSize / 2 ** 20) } : {};
  if (sim > 0) return { gb: sim, source: 'simulated', ...heap };
  const dm = (navigator as any).deviceMemory;
  return dm ? { gb: dm, source: 'navigator.deviceMemory', ...heap } : { gb: 4, source: 'not detectable – assuming 4 GB', ...heap };
}

export interface ChunkPlan { ram: RamInfo; perf: Perf; budgetMB: number; chunkSec: number; queue: number; bitrateMul: number; note: string; }

export function planChunks(perf: Perf, inputBytesPerSec: number, srcPixels: number, cams: number, outPixels: number): ChunkPlan {
  const ram = detectRam();
  const frac = { low: 0.04, auto: 0.1, high: 0.2 }[perf];
  let budget = ram.gb * 2 ** 30 * frac;
  if (ram.heapLimitMB) budget = Math.min(budget, Math.max(48 * 2 ** 20, (ram.heapLimitMB - (ram.heapUsedMB ?? 0)) * 2 ** 20 * 0.4));
  const queue = perf === 'low' ? 3 : perf === 'high' ? 10 : 6;
  const decoded = cams * (queue + 4) * srcPixels * 1.5 + outPixels * 4 * 3;
  const avail = Math.max(8 * 2 ** 20, budget - decoded);
  // two chunk buffers per camera can be alive at once (current + read-ahead)
  const chunkSec = Math.max(1, Math.min(60, Math.floor(avail / Math.max(1, inputBytesPerSec * 2))));
  return {
    ram, perf, budgetMB: Math.round(budget / 2 ** 20), chunkSec, queue, bitrateMul: perf === 'high' ? 1.5 : perf === 'low' ? 0.8 : 1,
    note: `${ram.gb} GB RAM (${ram.source}) · ${perf} · ${chunkSec}s chunks · queue ${queue}`,
  };
}
