import { AsyncLocalStorage } from "node:async_hooks";
import { CONFIG } from "../config.js";
import {
  loadEncryptedSession,
  getCookiesForHost,
  parseSetCookieHeaders,
  updateCookieJar
} from "../auth/session.js";
import { logger } from "./logger.js";

export class SessionExpiredError extends Error {
  constructor(message = "La sesión en EVA ha expirado o no está iniciada. Invocá 'uca_iniciar_sesion'.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class GuaraniSessionExpiredError extends Error {
  constructor(message = "La sesión en SIU Guaraní ha expirado o no está iniciada. Invocá 'uca_iniciar_sesion'.") {
    super(message);
    this.name = "GuaraniSessionExpiredError";
  }
}

export class CampusSessionExpiredError extends Error {
  constructor(message = "La sesión en Campus Autogestión ha expirado o no está iniciada. Invocá 'uca_iniciar_sesion'.") {
    super(message);
    this.name = "CampusSessionExpiredError";
  }
}

// Mutex asincrónico re-entrante para serializar operaciones con SIU Guaraní
class AsyncMutex {
  private queue: Promise<unknown> = Promise.resolve();
  private storage = new AsyncLocalStorage<boolean>();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.storage.getStore()) {
      return fn();
    }
    const next = this.queue.then(() => this.storage.run(true, fn));
    this.queue = next.catch(() => {});
    return next;
  }
}

export const guaraniMutex = new AsyncMutex();

const UCA_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// Semáforo para limitar la concurrencia global de solicitudes a las plataformas UCA (máx 4 simultáneas)
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const httpLimiter = new Semaphore(4);

// Despacha peticiones con limitación de concurrencia y backoff exponencial ante 429/503 (solo métodos idempotentes GET/HEAD)
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
  const release = await httpLimiter.acquire();
  try {
    const method = (init.method || "GET").toUpperCase();
    const isIdempotent = method === "GET" || method === "HEAD";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, init);
      if (isIdempotent && (res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfterSec = parseInt(res.headers.get("retry-after") || "", 10);
        const delayMs = !isNaN(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : (attempt + 1) * 1500;
        logger.warn(`HTTP ${res.status} recibido de ${new URL(url).hostname}. Reintentando en ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    }
    throw new Error(`Petición HTTP fallida tras ${maxRetries} reintentos`);
  } finally {
    release();
  }
}

// Fetch interno autenticado para EVA Moodle
async function rawEvaFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const targetUrl = new URL(path, CONFIG.EVA_BASE_URL);
  const allowedOrigin = new URL(CONFIG.EVA_BASE_URL).origin;

  if (targetUrl.protocol !== "https:" || targetUrl.origin !== allowedOrigin) {
    throw new Error(
      `Acceso denegado: solo se permiten peticiones HTTPS hacia el origen oficial '${allowedOrigin}'. URL intentada: '${targetUrl.origin}'`
    );
  }

  const session = loadEncryptedSession();
  if (!session?.moodleSession && !session?.cookies) {
    throw new SessionExpiredError();
  }

  const jarCookies = getCookiesForHost(targetUrl.hostname, session);
  const cookieHeader =
    jarCookies ||
    (session.moodleSession
      ? session.moodleSession.includes("=")
        ? session.moodleSession
        : `MoodleSessionMdlSessEabc=${session.moodleSession}`
      : "");

  if (!cookieHeader) {
    throw new SessionExpiredError();
  }

  const headers = new Headers(options.headers);
  headers.set("Cookie", cookieHeader);
  headers.set("User-Agent", UCA_USER_AGENT);

  let currentUrl = targetUrl;
  let currentMethod = options.method || "GET";
  let currentBody = options.body;
  let response: Response | null = null;
  const maxRedirects = 4;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    response = await fetchWithRetry(currentUrl.href, {
      ...options,
      method: currentMethod,
      body: currentBody,
      redirect: "manual",
      headers,
      signal: options.signal || AbortSignal.timeout(20000)
    });

    // Actualizar cookies recibidas en Set-Cookie
    const newCookies = parseSetCookieHeaders(response.headers, currentUrl.hostname);
    if (newCookies.length > 0) {
      updateCookieJar(newCookies);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirección sin cabecera 'Location' en ${currentUrl.href}`);
      }
      const nextUrl = new URL(location, currentUrl);

      if (
        nextUrl.href.includes("/login/") ||
        nextUrl.href.includes("microsoftonline.com") ||
        nextUrl.href.includes("saml2")
      ) {
        throw new SessionExpiredError("La sesión en EVA ha expirado o requiere nueva autenticación.");
      }

      if (nextUrl.protocol !== "https:" || nextUrl.origin !== allowedOrigin) {
        throw new Error(`Acceso denegado: intento de redirección no permitida hacia '${nextUrl.origin}'`);
      }

      currentUrl = nextUrl;

      // RFC 9110: 301, 302 y 303 deben transformarse a GET sin body
      if ([301, 302, 303].includes(response.status)) {
        currentMethod = "GET";
        currentBody = undefined;
        headers.delete("Content-Type");
        headers.delete("Content-Length");
      }

      continue;
    }

    break;
  }

  return response!;
}

// Fetch autenticado para EVA Moodle con reintento automático mediante refresh silencioso
export async function evaFetch(
  path: string,
  options: RequestInit = {},
  allowRefresh = true
): Promise<Response> {
  try {
    return await rawEvaFetch(path, options);
  } catch (err) {
    if (err instanceof SessionExpiredError && allowRefresh) {
      const session = loadEncryptedSession();
      if (session) {
        try {
          const { silentRefreshEva } = await import("../auth/browser-driver.js");
          const refreshed = await silentRefreshEva();
          if (refreshed) {
            return await rawEvaFetch(path, options);
          }
        } catch {}
      }
    }
    throw err;
  }
}

const disabledRpcMethods = new Set<string>();

export function isRpcMethodAvailable(methodName: string): boolean {
  return !disabledRpcMethods.has(methodName);
}

// Invocación a servicios AJAX oficiales de Moodle (/lib/ajax/service.php)
export async function evaAjaxRpc<T = unknown>(
  methodName: string,
  args: Record<string, unknown> = {},
  allowRefresh = true
): Promise<T> {
  if (disabledRpcMethods.has(methodName)) {
    throw new Error(`Servicio Moodle '${methodName}' no disponible (deshabilitado en el servidor)`);
  }

  const session = loadEncryptedSession();
  if (!session?.moodleSession || !session?.sesskey) {
    throw new SessionExpiredError();
  }

  const url = `${CONFIG.EVA_BASE_URL}/lib/ajax/service.php?sesskey=${session.sesskey}&info=${methodName}`;
  const payload = [
    {
      index: 0,
      methodname: methodName,
      args
    }
  ];

  const response = await evaFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  }, allowRefresh);

  if (!response.ok) {
    logger.error(`Error HTTP ${response.status} en llamada AJAX ${methodName}`);
    throw new Error(`Error en servicio Moodle: HTTP ${response.status}`);
  }

  const result = (await response.json()) as Array<{
    error?: boolean;
    errorcode?: string;
    exception?: { message?: string; errorcode?: string };
    data?: T;
  }>;
  const first = result[0];

  if (!first) {
    throw new Error(`Respuesta vacía de Moodle en ${methodName}`);
  }

  if (first.error) {
    const errorcode = first.errorcode || first.exception?.errorcode;
    const errorMsg = first.exception?.message || "Error devuelto por el servidor Moodle";

    if (errorcode === "servicenotavailable") {
      disabledRpcMethods.add(methodName);
      logger.warn(`Servicio Moodle '${methodName}' no disponible en el servidor. Se utilizará scraping de respaldo.`);
      throw new Error(errorMsg);
    }

    if (
      errorcode === "servicerequireslogin" ||
      errorcode === "invalidsesskey" ||
      errorcode === "sessionerroruser"
    ) {
      if (allowRefresh) {
        try {
          const { silentRefreshEva } = await import("../auth/browser-driver.js");
          const refreshed = await silentRefreshEva();
          if (refreshed) {
            return await evaAjaxRpc<T>(methodName, args, false);
          }
        } catch {}
      }
      throw new SessionExpiredError(`Sesión en EVA vencida o inválida (${errorcode}). Invocá 'uca_iniciar_sesion'.`);
    }

    logger.error(`Error reportado por Moodle en ${methodName}: ${errorMsg} (${errorcode || "sin código"})`);
    throw new Error(errorMsg);
  }

  return first.data as T;
}

// Fetch interno para SIU Guaraní 3 con detección de expiración en 200/JSON
async function rawGuaraniFetch(pathOrUrl: string, options: RequestInit = {}): Promise<Response> {
  const allowedOrigin = new URL(CONFIG.GUARANI_BASE_URL).origin;
  const basePath = new URL(CONFIG.GUARANI_BASE_URL).pathname.replace(/\/$/, "");
  let cleanPath: string;

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    const parsed = new URL(pathOrUrl);
    if (parsed.origin !== allowedOrigin) {
      throw new Error(
        `Acceso denegado: solo se permiten peticiones HTTPS hacia el origen oficial '${allowedOrigin}'. URL intentada: '${parsed.origin}'`
      );
    }
    cleanPath = parsed.pathname + parsed.search;
  } else {
    cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  }

  const resolvedPath = cleanPath.startsWith(basePath) ? cleanPath : `${basePath}${cleanPath}`;
  const targetUrl = new URL(resolvedPath, CONFIG.GUARANI_BASE_URL);

  if (targetUrl.protocol !== "https:" || targetUrl.origin !== allowedOrigin) {
    throw new Error(
      `Acceso denegado: solo se permiten peticiones HTTPS hacia el origen oficial '${allowedOrigin}'. URL intentada: '${targetUrl.origin}'`
    );
  }

  const session = loadEncryptedSession();
  if (!session?.siuSession && !session?.cookies) {
    throw new GuaraniSessionExpiredError();
  }

  const jarCookies = getCookiesForHost(targetUrl.hostname, session);
  const cookieHeader =
    jarCookies ||
    (session.siuSession
      ? session.siuSession.includes("=")
        ? session.siuSession
        : `siu_sess__academicos_ua_ACAD=${session.siuSession}`
      : "");

  if (!cookieHeader) {
    throw new GuaraniSessionExpiredError();
  }

  const headers = new Headers(options.headers);
  headers.set("Cookie", cookieHeader);
  headers.set("User-Agent", UCA_USER_AGENT);
  if (!headers.has("X-Requested-With")) {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }

  const response = await fetchWithRetry(targetUrl.href, {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(20000)
  });

  // Actualizar cookies recibidas
  const newCookies = parseSetCookieHeaders(response.headers, targetUrl.hostname);
  if (newCookies.length > 0) {
    updateCookieJar(newCookies);
  }

  if (
    response.redirected &&
    !targetUrl.pathname.includes("/acceso/cambiar_carrera") &&
    (response.url.includes("/acceso/login") ||
      response.url.includes("/login") ||
      response.url.includes("microsoftonline.com") ||
      response.url.includes("saml2"))
  ) {
    throw new GuaraniSessionExpiredError("La sesión en SIU Guaraní ha expirado o requiere reautenticación.");
  }

  // Detectar expiración en respuestas HTTP 200 (Chulupi JSON cod: "-2", redirecciones relativas o formulario de login)
  const contentType = response.headers.get("content-type") || "";
  const isBinary =
    contentType.includes("application/pdf") ||
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/zip") ||
    contentType.startsWith("image/");

  if (!isBinary) {
    const clone = response.clone();
    try {
      const text = await clone.text();
      const isLoginRedirect =
        (text.includes('"cod":"-2"') || text.includes("'cod':'-2'")) &&
        (text.includes('/acceso/login') || text.includes('\\/acceso\\/login') || text.includes('/login'));
      const isLoginForm =
        text.includes('id="login"') ||
        text.includes('name="form_login"') ||
        text.includes("Autenticación - SIU-Guaraní");

      if (isLoginRedirect || isLoginForm) {
        throw new GuaraniSessionExpiredError("La sesión en SIU Guaraní ha expirado (Chulupi cod: -2 a login o pantalla de login).");
      }
    } catch (e) {
      if (e instanceof GuaraniSessionExpiredError) throw e;
    }
  }

  return response;
}

// Fetch autenticado para SIU Guaraní 3 con intento automático de refresh silencioso
export async function guaraniFetch(
  path: string,
  options: RequestInit = {},
  allowRefresh = true
): Promise<Response> {
  try {
    return await rawGuaraniFetch(path, options);
  } catch (err) {
    if (err instanceof GuaraniSessionExpiredError && allowRefresh) {
      const session = loadEncryptedSession();
      if (session) {
        try {
          const { silentRefreshGuarani } = await import("../auth/browser-driver.js");
          const refreshed = await silentRefreshGuarani();
          if (refreshed) {
            return await rawGuaraniFetch(path, options);
          }
        } catch {
          // Si falla el refresh silencioso, arrojar error original
        }
      }
    }
    throw err;
  }
}

// Fetch interno para Campus Autogestión (Next.js / REST)
async function rawCampusFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const targetUrl = new URL(path, CONFIG.CAMPUS_BASE_URL);
  const allowedOrigin = new URL(CONFIG.CAMPUS_BASE_URL).origin;

  if (targetUrl.protocol !== "https:" || targetUrl.origin !== allowedOrigin) {
    throw new Error(
      `Acceso denegado: solo se permiten peticiones HTTPS hacia el origen oficial '${allowedOrigin}'. URL intentada: '${targetUrl.origin}'`
    );
  }

  const session = loadEncryptedSession();
  const campusCookie = session?.campusSession || session?.campusToken;
  const jarCookies = getCookiesForHost(targetUrl.hostname, session);

  if (!campusCookie && !jarCookies) {
    throw new CampusSessionExpiredError();
  }

  const cookieHeader =
    jarCookies ||
    (campusCookie
      ? campusCookie.includes("=")
        ? campusCookie
        : `uca_campus_autogestion_session=${campusCookie}`
      : "");

  const headers = new Headers(options.headers);
  headers.set("Cookie", cookieHeader);
  headers.set("User-Agent", UCA_USER_AGENT);

  const response = await fetchWithRetry(targetUrl.href, {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(20000)
  });

  // Actualizar cookies recibidas
  const newCookies = parseSetCookieHeaders(response.headers, targetUrl.hostname);
  if (newCookies.length > 0) {
    updateCookieJar(newCookies);
  }

  if (
    response.redirected &&
    (response.url.includes("/login") ||
      response.url.includes("/access") ||
      response.url.includes("microsoftonline.com") ||
      response.url.includes("saml2"))
  ) {
    throw new CampusSessionExpiredError();
  }

  // Detectar login en HTTP 200 de Campus Autogestión (portal Next.js) para disparar silent refresh
  const clone = response.clone();
  try {
    const text = await clone.text();
    if (
      text.includes("Acceso al Campus") &&
      (text.includes("¡Te damos la bienvenida!") ||
        text.includes("!Te damos la bienvenida!") ||
        text.includes("Ingresá con tu cuenta") ||
        text.includes("Ingresa con tu cuenta"))
    ) {
      throw new CampusSessionExpiredError();
    }
  } catch (e) {
    if (e instanceof CampusSessionExpiredError) throw e;
  }

  return response;
}

// Fetch autenticado para Campus Autogestión con intento automático de refresh silencioso
export async function campusFetch(
  path: string,
  options: RequestInit = {},
  allowRefresh = true
): Promise<Response> {
  try {
    return await rawCampusFetch(path, options);
  } catch (err) {
    if (err instanceof CampusSessionExpiredError && allowRefresh) {
      const session = loadEncryptedSession();
      if (session) {
        try {
          const { silentRefreshGuarani } = await import("../auth/browser-driver.js");
          const refreshed = await silentRefreshGuarani();
          if (refreshed) {
            return await rawCampusFetch(path, options);
          }
        } catch {}
      }
    }
    throw err;
  }
}
