// Contador simple de operaciones de escritura en vuelo (para no cortar una mutación al cerrar el cliente)
let inflight = 0;

export function beginWrite(): void {
  inflight++;
}

export function endWrite(): void {
  if (inflight > 0) inflight--;
}

export function inflightWrites(): number {
  return inflight;
}

/** Espera hasta maxMs a que no queden escrituras en vuelo. */
export async function waitForWrites(maxMs: number): Promise<void> {
  const t0 = Date.now();
  while (inflight > 0 && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
