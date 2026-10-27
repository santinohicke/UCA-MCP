import fs from "node:fs";
import { CONFIG, initStorage } from "../config.js";
import { logger } from "../shared/logger.js";

interface LockInfo {
  pid: number;
  startTime: number;
}

// Adquisición atómica de lock de proceso con openSync 'wx' y verificación de vivacidad del PID
export function acquireLock(customLockPath?: string): boolean {
  if (!fs.existsSync(CONFIG.BASE_DIR)) {
    fs.mkdirSync(CONFIG.BASE_DIR, { recursive: true, mode: 0o700 });
  }
  const lockPath = customLockPath || CONFIG.LOCKFILE_PATH;

  const tryCreate = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      const content = JSON.stringify({ pid: process.pid, startTime: Date.now() });
      fs.writeFileSync(fd, content, "utf8");
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EEXIST") {
        return false;
      }
      logger.error(`Error al abrir archivo de lock en ${lockPath}`, err);
      return false;
    }
  };

  if (tryCreate()) return true;

  // Si ya existía, verificar si el PID está vivo o si el lock expiró (> 6 min para superar el timeout de login de 5 min)
  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const info: LockInfo = JSON.parse(content);
    const isStale = Date.now() - (info.startTime || 0) > 360000;

    let isAlive = true;
    try {
      process.kill(info.pid, 0);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ESRCH") {
        isAlive = false;
      }
    }

    if (!isAlive || isStale) {
      logger.warn(`Liberando lock huérfano/expirado del PID ${info.pid} en ${lockPath}`);
      try {
        fs.unlinkSync(lockPath);
      } catch {}
      return tryCreate();
    }
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      // Si el archivo fue creado o modificado hace menos de 10 segundos, está en proceso de creación: tratar como tomado
      if (Date.now() - stat.mtimeMs < 10000) {
        return false;
      }
      // Solo si es un archivo corrupto/ilegible y viejo (> 10s), purgar el archivo
      fs.unlinkSync(lockPath);
      return tryCreate();
    } catch {
      return false;
    }
  }

  return false;
}

export async function waitForLock(customLockPath?: string, maxWaitMs = 12000): Promise<boolean> {
  const start = Date.now();
  while (!acquireLock(customLockPath)) {
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

export function releaseLock(customLockPath?: string): void {
  const lockPath = customLockPath || CONFIG.LOCKFILE_PATH;
  if (!fs.existsSync(lockPath)) return;

  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const info: LockInfo = JSON.parse(content);
    if (info.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Si no se puede parsear o eliminar, ignorar
  }
}

// Ejecuta una función protegida por un lock atómico entre procesos con reintentos
export async function withInterProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 15000
): Promise<T> {
  const start = Date.now();
  while (!acquireLock(lockPath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Tiempo de espera agotado (${timeoutMs}ms) al adquirir el bloqueo inter-proceso en ${lockPath}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}
