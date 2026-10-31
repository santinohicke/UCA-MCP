import { registerSessionPurgeHook } from "../auth/session.js";

// Caché en memoria con TTL corto para consultas de solo lectura lentas.
// Deduplica llamadas simultáneas (misma clave) y permite forzar el refresco.
// Seguridad: un contador de "generación" se incrementa al limpiar (logout / cambio de usuario);
// una promesa en vuelo que termina después de un clear NO escribe en el store.
const MAX_ENTRIES = 200;
const store = new Map<string, { value: unknown; expires: number; startedSeq: number }>();
const inflight = new Map<string, Promise<unknown>>();
let generation = 0;
let seq = 0;

function prune(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [k, v] of store) {
    if (v.expires <= now) store.delete(k);
  }
  // Si siguen siendo demasiadas, descartar las más antiguas (orden de inserción)
  while (store.size >= MAX_ENTRIES) {
    const first = store.keys().next();
    if (first.done) break;
    store.delete(first.value);
  }
}

export async function ttlCached<T>(
  key: string,
  ttlMs: number,
  force: boolean,
  fn: () => Promise<T>,
  // Permite no cachear resultados parciales/incompletos (devuelve false para no guardar)
  shouldCache?: (value: T) => boolean
): Promise<T> {
  if (!force) {
    const hit = store.get(key);
    if (hit && Date.now() < hit.expires) return hit.value as T;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const startGen = generation;
  const mySeq = ++seq;
  const p = fn()
    .then((value) => {
      if (startGen === generation && (!shouldCache || shouldCache(value))) {
        const now = Date.now();
        const prev = store.get(key);
        // Con force=true no pisar un resultado más nuevo con uno viejo
        if (!prev || prev.startedSeq < mySeq) {
          prune(now);
          store.set(key, { value, expires: now + ttlMs, startedSeq: mySeq });
        }
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function clearTtlCache(): void {
  generation++;
  store.clear();
  inflight.clear();
}

registerSessionPurgeHook(clearTtlCache);
