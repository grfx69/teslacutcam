// Tiny IndexedDB key/value store (remembers the last folder handle and the uploaded logo).
const open = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('teslacutcam', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
export async function idbGet<T = unknown>(k: string): Promise<T | undefined> {
  try { const db = await open(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  catch { return undefined; }
}
export async function idbSet(k: string, v: unknown): Promise<void> {
  try { const db = await open(); await new Promise<void>((res, rej) => { const t = db.transaction('kv', 'readwrite'); v === undefined ? t.objectStore('kv').delete(k) : t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  catch (e) { console.warn('[TeslaCutCam] could not save', k, e); }
}
