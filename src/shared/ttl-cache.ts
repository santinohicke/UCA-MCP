import { registerSessionPurgeHook } from "../auth/session.js";

// Caché en memoria con TTL corto para consultas de solo lectura lentas.
// Deduplica llamadas simultáneas (misma clave) y permite forzar el refresco.
const store = new Map<string, { value: unknown; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();

export async function ttlCached<T>(
  key: string,
  ttlMs: number,
  force: boolean,
  fn: () => Promise<T>
): Promise<T> {
  if (!force) {
    const hit = store.get(key);
    if (hit && Date.now() < hit.expires) return hit.value as T;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const p = fn()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function clearTtlCache(): void {
  store.clear();
  inflight.clear();
}

registerSessionPurgeHook(clearTtlCache);
