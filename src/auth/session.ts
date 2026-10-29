import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG, initStorage } from "../config.js";
import { getOrCreateMasterKey, clearCachedMasterKey } from "./keychain.js";
import { acquireLock, releaseLock } from "./session-store.js";
import { logger } from "../shared/logger.js";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
}

export interface SessionData {
  cookies?: StoredCookie[];
  moodleSession?: string;
  sesskey?: string;
  siuSession?: string;
  campusSession?: string;
  campusToken?: string;
  userEmail?: string;
  userName?: string;
  carreraActiva?: string;
  carrerasDisponibles?: Array<{ id: string; nombre: string }>;
  evaMaterias?: Array<{ id: number; nombre: string; codigo?: string; url: string }>;
  savedAt: string;
}

// Obtiene todas las cookies válidas para un hostname dado
export function getCookiesForHost(hostname: string, session?: SessionData | null): string {
  const sess = session || loadEncryptedSession();
  if (!sess || !sess.cookies || sess.cookies.length === 0) return "";
  const now = Date.now() / 1000;
  const host = hostname.toLowerCase();

  const matched = sess.cookies.filter((c) => {
    if (c.expires && c.expires > 0 && c.expires < now) return false;
    const cookieDomain = (c.domain || "").replace(/^\./, "").toLowerCase();
    return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
  });

  return matched.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Parsea cabeceras Set-Cookie de respuestas HTTP
export function parseSetCookieHeaders(responseHeaders: Headers, host: string): StoredCookie[] {
  const cookies: StoredCookie[] = [];
  const rawHeaders: string[] =
    typeof (responseHeaders as any).getSetCookie === "function"
      ? (responseHeaders as any).getSetCookie()
      : [responseHeaders.get("set-cookie")].filter(Boolean);

  for (const str of rawHeaders) {
    if (!str) continue;
    const parts = str.split(";").map((p) => p.trim());
    const [first, ...flags] = parts;
    const eqIdx = first.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = first.substring(0, eqIdx).trim();
    const value = first.substring(eqIdx + 1).trim();

    let domain = host;
    let cookiePath = "/";
    let expires: number | undefined;

    for (const flag of flags) {
      const [k, v] = flag.split("=").map((s) => s.trim());
      const kLower = k.toLowerCase();
      if (kLower === "domain" && v) domain = v.replace(/^\./, "");
      if (kLower === "path" && v) cookiePath = v;
      if (kLower === "expires" && v) {
        const expTime = Date.parse(v);
        if (!isNaN(expTime)) expires = Math.floor(expTime / 1000);
      }
      if (kLower === "max-age" && v) {
        const sec = parseInt(v, 10);
        if (!isNaN(sec)) expires = Math.floor(Date.now() / 1000) + sec;
      }
    }
    cookies.push({ name, value, domain, path: cookiePath, expires });
  }
  return cookies;
}

// Fusiona cookies entrantes en un jar existente sin pisar cookies no afectadas de otros dominios
export function mergeCookies(existing: StoredCookie[], incoming: StoredCookie[]): StoredCookie[] {
  const normDomain = (d?: string) => (d || "").replace(/^\./, "").toLowerCase();
  const jar = [...existing];
  for (const nc of incoming) {
    const idx = jar.findIndex(
      (c) => c.name === nc.name && (normDomain(c.domain) === normDomain(nc.domain) || !nc.domain || !c.domain)
    );
    if (idx >= 0) {
      jar[idx] = { ...jar[idx], ...nc };
    } else {
      jar.push(nc);
    }
  }
  return jar;
}

let cookieSaveTimeout: NodeJS.Timeout | null = null;
let pendingCookiesToMerge: StoredCookie[] = [];

// Escribe en disco cualquier actualización diferida de cookies pendiente
export function flushPendingSessionSave(): void {
  if (cookieSaveTimeout) {
    clearTimeout(cookieSaveTimeout);
    cookieSaveTimeout = null;
  }
  if (pendingCookiesToMerge.length > 0) {
    const toApply = [...pendingCookiesToMerge];
    pendingCookiesToMerge = [];
    const session = loadEncryptedSession();
    if (session) {
      session.cookies = mergeCookies(session.cookies || [], toApply);
      saveEncryptedSession(session, false);
    }
  }
}

if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("beforeExit", flushPendingSessionSave);
}

// Actualiza el cookie jar persistente en session.enc con debounce de 1.5s y sin registrar ruido de auditoría
export function updateCookieJar(newCookies: StoredCookie[]): void {
  if (newCookies.length === 0) return;
  pendingCookiesToMerge = mergeCookies(pendingCookiesToMerge, newCookies);

  if (cachedSession) {
    cachedSession.cookies = mergeCookies(cachedSession.cookies || [], newCookies);
  }

  if (cookieSaveTimeout) clearTimeout(cookieSaveTimeout);
  cookieSaveTimeout = setTimeout(() => {
    cookieSaveTimeout = null;
    flushPendingSessionSave();
  }, 1500);
}

let cachedSession: SessionData | null = null;
let lastMtime = 0;

// Guarda la sesión cifrada con AES-256-GCM de forma atómica y serializada entre procesos
// Solo audita si shouldAudit=true (ej. inicios de sesión formal), previniendo saturación de audit.log
export function saveEncryptedSession(data: SessionData, shouldAudit = false): void {
  if (!fs.existsSync(CONFIG.BASE_DIR)) {
    fs.mkdirSync(CONFIG.BASE_DIR, { recursive: true, mode: 0o700 });
  }

  const sessionLockPath = `${CONFIG.ENCRYPTED_SESSION_PATH}.lock`;
  let acquired = false;
  // Intento de adquisición del lock con breve pausa para serializar concurrencia sin saturar CPU
  for (let attempt = 0; attempt < 5; attempt++) {
    if (acquireLock(sessionLockPath)) {
      acquired = true;
      break;
    }
    if (attempt < 4) {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      } catch {}
    }
  }

  try {
    const key = getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const json = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Estructura v1: Versión (1 byte = 0x01) + IV (12) + AuthTag (16) + Datos cifrados
    const versionByte = Buffer.from([0x01]);
    const buffer = Buffer.concat([versionByte, iv, authTag, encrypted]);

    const uniqueSuffix = `${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
    const tempPath = `${CONFIG.ENCRYPTED_SESSION_PATH}.${uniqueSuffix}.tmp`;
    fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
    try {
      fs.renameSync(tempPath, CONFIG.ENCRYPTED_SESSION_PATH);
    } catch (renameErr) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
      throw renameErr;
    }

    cachedSession = data;
    lastMtime = fs.statSync(CONFIG.ENCRYPTED_SESSION_PATH).mtimeMs;
    if (shouldAudit) {
      logger.audit("session_saved", { userEmail: data.userEmail });
    }
  } finally {
    if (acquired) {
      releaseLock(sessionLockPath);
    }
  }
}

// Carga y desencripta la sesión con caché en memoria basado en mtime (compatible v1 y legacy)
export function loadEncryptedSession(): SessionData | null {
  if (!fs.existsSync(CONFIG.ENCRYPTED_SESSION_PATH)) {
    cachedSession = null;
    lastMtime = 0;
    return null;
  }

  try {
    const stat = fs.statSync(CONFIG.ENCRYPTED_SESSION_PATH);
    if (cachedSession && stat.mtimeMs === lastMtime) {
      return cachedSession;
    }

    const key = getOrCreateMasterKey();
    const buffer = fs.readFileSync(CONFIG.ENCRYPTED_SESSION_PATH);

    if (buffer.length < 28) {
      return null;
    }

    let iv: Buffer;
    let authTag: Buffer;
    let ciphertext: Buffer;

    if (buffer[0] === 0x01 && buffer.length >= 29) {
      // Formato v1 con byte de versión explícito
      iv = buffer.subarray(1, 13);
      authTag = buffer.subarray(13, 29);
      ciphertext = buffer.subarray(29);
    } else {
      // Formato legacy sin byte de versión
      iv = buffer.subarray(0, 12);
      authTag = buffer.subarray(12, 28);
      ciphertext = buffer.subarray(28);
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    cachedSession = JSON.parse(decrypted.toString("utf8")) as SessionData;
    lastMtime = stat.mtimeMs;
    return cachedSession;
  } catch (err) {
    logger.error("Fallo al descifrar session.enc", err);
    return null;
  }
}

const sessionPurgeHooks: Array<() => void> = [];
export function registerSessionPurgeHook(hook: () => void): void {
  sessionPurgeHooks.push(hook);
}

// Purga local completa de sesión
export function clearSession(): void {
  if (cookieSaveTimeout) {
    clearTimeout(cookieSaveTimeout);
    cookieSaveTimeout = null;
    pendingCookiesToMerge = [];
  }
  if (fs.existsSync(CONFIG.ENCRYPTED_SESSION_PATH)) {
    fs.unlinkSync(CONFIG.ENCRYPTED_SESSION_PATH);
  }
  cachedSession = null;
  lastMtime = 0;
  clearCachedMasterKey();

  // Invalidar cachés en memoria de plataformas y purgar CACHE_DIR
  for (const hook of sessionPurgeHooks) {
    try {
      hook();
    } catch {}
  }
  if (fs.existsSync(CONFIG.CACHE_DIR)) {
    try {
      for (const file of fs.readdirSync(CONFIG.CACHE_DIR)) {
        try {
          fs.unlinkSync(path.join(CONFIG.CACHE_DIR, file));
        } catch {}
      }
    } catch {}
  }

  logger.audit("session_cleared", {});
}
