import fs from "node:fs";
import { CONFIG, initStorage } from "../config.js";
import { saveEncryptedSession, loadEncryptedSession, mergeCookies, type StoredCookie } from "./session.js";
import { acquireLock, releaseLock, waitForLock } from "./session-store.js";
import { logger } from "../shared/logger.js";

const CHANNELS = ["msedge", "chrome", "chromium"] as const;

// Registro de contextos activos para cierre garantizado ante terminación de proceso
const activeContexts = new Set<any>();

function registerExitCleanupOnce() {
  if ((globalThis as any).__ucaBrowserCleanupRegistered) return;
  (globalThis as any).__ucaBrowserCleanupRegistered = true;

  let isExiting = false;
  const closeAllAsync = async (exitCode?: number) => {
    if (isExiting) return;
    isExiting = true;
    const list = Array.from(activeContexts);
    activeContexts.clear();

    const cleanupPromise = Promise.allSettled(
      list.map(async (ctx) => {
        try {
          const proc = typeof ctx.browser === "function" ? ctx.browser()?.process() : null;
          await ctx.close().catch(() => {});
          if (proc && !proc.killed) {
            try {
              proc.kill("SIGTERM");
            } catch {}
          }
        } catch {}
      })
    );

    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
    await Promise.race([cleanupPromise, timeoutPromise]);

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  };

  process.once("SIGINT", () => {
    void closeAllAsync(130);
  });
  process.once("SIGTERM", () => {
    void closeAllAsync(143);
  });
  process.on("beforeExit", () => {
    void closeAllAsync();
  });
  process.once("exit", () => {
    for (const ctx of activeContexts) {
      try {
        const proc = typeof ctx.browser === "function" ? ctx.browser()?.process() : null;
        if (proc && !proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      } catch {}
    }
    activeContexts.clear();
  });
}

// Detección ultrarrápida por ruta de sistema sin lanzar procesos de navegador
export function detectBrowserChannelByPath(): string | null {
  const p = process.platform;
  if (p === "win32") {
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localApp = process.env.LOCALAPPDATA || "";

    const candidates: Array<[string, string]> = [
      ["msedge", `${progFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`],
      ["msedge", `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`],
      ["chrome", `${progFiles}\\Google\\Chrome\\Application\\chrome.exe`],
      ["chrome", `${progFilesX86}\\Google\\Chrome\\Application\\chrome.exe`],
      ["chrome", `${localApp}\\Google\\Chrome\\Application\\chrome.exe`]
    ];
    for (const [ch, path] of candidates) {
      if (fs.existsSync(path)) return ch;
    }
  } else if (p === "darwin") {
    const macCandidates: Array<[string, string]> = [
      ["chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["msedge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    ];
    for (const [ch, path] of macCandidates) {
      if (fs.existsSync(path)) return ch;
    }
  } else {
    // Linux
    const linuxCandidates: Array<[string, string]> = [
      ["chrome", "/usr/bin/google-chrome"],
      ["chrome", "/usr/bin/google-chrome-stable"],
      ["chromium", "/usr/bin/chromium"],
      ["chromium", "/usr/bin/chromium-browser"],
      ["msedge", "/usr/bin/microsoft-edge"],
      ["msedge", "/usr/bin/microsoft-edge-stable"]
    ];
    for (const [ch, path] of linuxCandidates) {
      if (fs.existsSync(path)) return ch;
    }
  }
  return null;
}

// Encuentra el primer canal de navegador instalado en el sistema
export async function getAvailableChannel(): Promise<string> {
  const detected = detectBrowserChannelByPath();
  if (detected) return detected;

  // Fallback con import perezoso de playwright para probar canales
  const { chromium } = await import("playwright-core");
  for (const channel of CHANNELS) {
    try {
      const browser = await chromium.launch({ channel, headless: true });
      await browser.close();
      return channel;
    } catch {
      // Probar siguiente canal
    }
  }
  throw new Error(
    "No se encontró ningún navegador compatible (Microsoft Edge, Google Chrome o Chromium) en el sistema. En macOS sin Edge/Chrome, instalá Google Chrome o Microsoft Edge."
  );
}

export async function closeAllActiveContexts(): Promise<void> {
  const list = Array.from(activeContexts);
  activeContexts.clear();
  await Promise.allSettled(
    list.map(async (ctx) => {
      try {
        await ctx.close().catch(() => {});
      } catch {}
    })
  );
}

// Single-flight promises para evitar colisiones de locks en llamadas concurrentes
let guaraniRefreshPromise: Promise<boolean> | null = null;
let evaRefreshPromise: Promise<boolean> | null = null;

// Refresca de forma silenciosa la sesión de Guaraní en segundo plano (usando KMSI y cookies persistentes)
export async function silentRefreshGuarani(): Promise<boolean> {
  if (guaraniRefreshPromise) return guaraniRefreshPromise;

  guaraniRefreshPromise = (async () => {
    const session = loadEncryptedSession();
    if (!session) return false;
    let acquired = acquireLock();
    if (!acquired) {
      acquired = await waitForLock(undefined, 10000);
      if (!acquired) {
        const check = loadEncryptedSession();
        if (check && Date.now() - new Date(check.savedAt).getTime() < 30000) return true;
        return false;
      }
    }

    try {
      const { chromium } = await import("playwright-core");
      const channel = await getAvailableChannel();
      logger.info(`Iniciando refresh silencioso de Guaraní en segundo plano con ${channel}...`);

      registerExitCleanupOnce();
      const context = await chromium.launchPersistentContext(
        CONFIG.BROWSER_PROFILE_DIR,
        {
          channel,
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check"]
        }
      );
      activeContexts.add(context);

      try {
        const page = context.pages()[0] || (await context.newPage());
        // 1. Asegurar sesión institucional en Autogestión vía SSO de Microsoft Entra ID
        try {
          await page.goto("https://autogestion.uca.edu.ar/login", {
            timeout: 20000,
            waitUntil: "networkidle"
          });
        } catch {}

        // Limpiar cookie previa de Guaraní para asegurar captura de una sesión recién emitida
        try {
          const oldCookies = await context.cookies();
          for (const c of oldCookies) {
            if (c.name.startsWith("siu_sess") || c.domain.includes("guarani")) {
              await context.clearCookies({ name: c.name, domain: c.domain }).catch(() => {});
            }
          }
        } catch {}

        // 2. Navegar a /guarani para emitir el ticket de Guaraní y redirigir directamente
        await page.goto("https://autogestion.uca.edu.ar/guarani", {
          timeout: 25000,
          waitUntil: "domcontentloaded"
        });

        let siuSession: string | undefined;
        for (let i = 0; i < 10; i++) {
          const cookies = await context.cookies();
          const siuCookie = cookies.find((c) => c.name.startsWith("siu_sess"));
          if (siuCookie) {
            siuSession = siuCookie.value;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        if (siuSession) {
          const allCookies = await context.cookies();
          const storedCookies: StoredCookie[] = allCookies
            .filter((c) => c.domain.endsWith(".uca.edu.ar") || c.domain === "uca.edu.ar")
            .map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires
            }));

          const campusCookie = allCookies.find(
            (c) => c.name === "uca_campus_autogestion_session" || c.name.includes("campus_autogestion")
          );

          const freshSession = loadEncryptedSession() || session;
          const mergedCookies = mergeCookies(freshSession.cookies || [], storedCookies);

          saveEncryptedSession({
            ...freshSession,
            siuSession,
            campusSession: campusCookie ? campusCookie.value : freshSession.campusSession,
            cookies: mergedCookies,
            savedAt: new Date().toISOString()
          });
          logger.info("Refresh silencioso de Guaraní y Campus completado exitosamente.");
          return true;
        }
        return false;
      } finally {
        activeContexts.delete(context);
        await context.close();
      }
    } catch (err) {
      logger.warn(`Refresh silencioso de Guaraní no pudo completarse: ${err}`);
      return false;
    } finally {
      releaseLock();
    }
  })();

  try {
    return await guaraniRefreshPromise;
  } finally {
    guaraniRefreshPromise = null;
  }
}

// Refresca de forma silenciosa la sesión de EVA Moodle en segundo plano usando el perfil persistente con KMSI
export async function silentRefreshEva(): Promise<boolean> {
  if (evaRefreshPromise) return evaRefreshPromise;

  evaRefreshPromise = (async () => {
    const session = loadEncryptedSession();
    if (!session) return false;
    let acquired = acquireLock();
    if (!acquired) {
      acquired = await waitForLock(undefined, 10000);
      if (!acquired) {
        const check = loadEncryptedSession();
        if (check && Date.now() - new Date(check.savedAt).getTime() < 30000) return true;
        return false;
      }
    }

    try {
      const { chromium } = await import("playwright-core");
      const channel = await getAvailableChannel();
      logger.info(`Iniciando refresh silencioso de EVA Moodle en segundo plano con ${channel}...`);

      registerExitCleanupOnce();
      const context = await chromium.launchPersistentContext(
        CONFIG.BROWSER_PROFILE_DIR,
        {
          channel,
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check"]
        }
      );
      activeContexts.add(context);

      try {
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(`${CONFIG.EVA_BASE_URL}/login/index.php`, {
          timeout: 25000,
          waitUntil: "domcontentloaded"
        });

        let moodleSession: string | undefined;
        let sesskey: string | undefined;

        for (let i = 0; i < 8; i++) {
          const curUrl = page.url();
          const onLogin =
            curUrl.includes("/login/") ||
            curUrl.includes("microsoftonline.com") ||
            curUrl.includes("saml2");

          if (!onLogin && curUrl.startsWith(CONFIG.EVA_BASE_URL)) {
            const cookies = await context.cookies([CONFIG.EVA_BASE_URL]);
            const moodleCookie = cookies.find((c) => c.name.startsWith("MoodleSession"));
            if (moodleCookie) {
              moodleSession = moodleCookie.value;
              try {
                sesskey = await page.evaluate(() => {
                  const m = (window as any).M;
                  return (
                    m?.cfg?.sesskey ||
                    (document.querySelector('input[name="sesskey"]') as HTMLInputElement | null)?.value
                  );
                });
              } catch {}
              if (moodleSession && sesskey) break;
            }
          }
          await new Promise((r) => setTimeout(r, 1500));
        }

        if (moodleSession && sesskey) {
          const allCookies = await context.cookies();
          const storedCookies: StoredCookie[] = allCookies
            .filter((c) => c.domain.endsWith(".uca.edu.ar") || c.domain === "uca.edu.ar")
            .map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires
            }));

          const freshSession = loadEncryptedSession() || session;
          const mergedCookies = mergeCookies(freshSession.cookies || [], storedCookies);

          saveEncryptedSession({
            ...freshSession,
            moodleSession,
            sesskey,
            cookies: mergedCookies,
            savedAt: new Date().toISOString()
          });
          logger.info("Refresh silencioso de EVA completado exitosamente.");
          return true;
        }
        return false;
      } finally {
        activeContexts.delete(context);
        await context.close();
      }
    } catch (err) {
      logger.warn(`Refresh silencioso de EVA no pudo completarse: ${err}`);
      return false;
    } finally {
      releaseLock();
    }
  })();

  try {
    return await evaRefreshPromise;
  } finally {
    evaRefreshPromise = null;
  }
}

export interface BackgroundLoginStatus {
  estado: "no_iniciado" | "en_curso" | "exitoso" | "fallido" | "timeout" | "cancelado";
  iniciadoEn?: string;
  finalizadoEn?: string;
  error?: string;
}

let loginStatus: BackgroundLoginStatus = { estado: "no_iniciado" };

export function getBackgroundLoginStatus(): BackgroundLoginStatus {
  return loginStatus;
}

// Inicia el navegador interactivo para que el estudiante inicie sesión
export async function runLogin(): Promise<boolean> {
  initStorage();

  if (!acquireLock()) {
    console.log("Ya hay otro proceso de login o actualización en curso. Esperá unos segundos.");
    return false;
  }

  loginStatus = { estado: "en_curso", iniciadoEn: new Date().toISOString() };
  await executeInteractiveLogin();
  return loginStatus.estado === "exitoso";
}

// Inicia el login de forma asincrónica en segundo plano (para invocación no bloqueante desde tools MCP)
// Retorna true si se pudo adquirir el lock e iniciar el proceso, o false si ya hay otro proceso
export function startBackgroundLogin(forzarRelogin = false): boolean {
  initStorage();

  if (!acquireLock()) {
    logger.warn("No se pudo iniciar login en segundo plano: cerrojo profile.lock retenido por otro proceso.");
    return false;
  }

  if (forzarRelogin) {
    if (fs.existsSync(CONFIG.BROWSER_PROFILE_DIR)) {
      try {
        fs.rmSync(CONFIG.BROWSER_PROFILE_DIR, { recursive: true, force: true });
      } catch (e) {
        logger.warn(`No se pudo purgar browser-profile antes de forzar relogin: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (fs.existsSync(CONFIG.CERTIFICADOS_DIR)) {
      try {
        fs.rmSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, force: true });
      } catch {}
    }
  }

  loginStatus = { estado: "en_curso", iniciadoEn: new Date().toISOString() };
  setTimeout(() => {
    executeInteractiveLogin().catch((err) => {
      logger.error("Error en login en background", err);
      loginStatus = {
        estado: "fallido",
        iniciadoEn: loginStatus.iniciadoEn,
        finalizadoEn: new Date().toISOString(),
        error: String(err)
      };
      releaseLock();
    });
  }, 50);

  return true;
}

// Ejecuta el login interactivo asumiendo que el cerrojo profile.lock ya fue adquirido por el llamador
async function executeInteractiveLogin(): Promise<void> {
  try {
    const { chromium } = await import("playwright-core");
    const channel = await getAvailableChannel();
    console.log(`Abriendo ventana de login institucional con ${channel}...`);

    registerExitCleanupOnce();
    const context = await chromium.launchPersistentContext(
      CONFIG.BROWSER_PROFILE_DIR,
      {
        channel,
        headless: false,
        viewport: null
      }
    );
    activeContexts.add(context);

    const page = context.pages()[0] || (await context.newPage());
    console.log("Navegando al portal de EVA UCA...");
    await page.goto(`${CONFIG.EVA_BASE_URL}/login/index.php`);

    console.log("Por favor, ingresá tus credenciales @uca.edu.ar y completá el segundo factor (2FA) en la ventana del navegador...");

    // Monitorea hasta que el estudiante haya iniciado sesión en EVA
    let moodleSession: string | undefined;
    let sesskey: string | undefined;
    let userEmail: string | undefined;
    let userName: string | undefined;
    let siuSession: string | undefined;
    let campusSession: string | undefined;
    let carreraActiva: string | undefined;
    let carrerasDisponibles: Array<{ id: string; nombre: string }> | undefined;

    const maxWaitMs = 5 * 60 * 1000; // 5 minutos máximo
    const startTime = Date.now();
    let completed = false;
    let windowClosed = false;

    while (Date.now() - startTime < maxWaitMs) {
      if (context.pages().length === 0) {
        console.log("La ventana del navegador se cerró.");
        windowClosed = true;
        break;
      }

      const currentUrl = page.url();
      const isStillOnLogin =
        currentUrl.includes("/login/") ||
        currentUrl.includes("microsoftonline.com") ||
        currentUrl.includes("saml2");

      if (!isStillOnLogin && currentUrl.startsWith(CONFIG.EVA_BASE_URL)) {
        const cookies = await context.cookies([CONFIG.EVA_BASE_URL, CONFIG.GUARANI_BASE_URL]);
        const moodleCookie = cookies.find((c) => c.name.startsWith("MoodleSession"));

        if (moodleCookie) {
          moodleSession = moodleCookie.value;

          try {
            const authInfo = await page.evaluate(async () => {
              const m = (window as unknown as {
                M?: { cfg?: { sesskey?: string; userId?: number; userEmail?: string; userIsLoggedIn?: boolean } };
              }).M;
              const sesskey =
                m?.cfg?.sesskey ||
                (document.querySelector('input[name="sesskey"]') as HTMLInputElement | null)?.value;
              const userId = m?.cfg?.userId || 0;
              const userMenu = document.querySelector(".usertext") || document.querySelector(".userbutton");
              const userText = userMenu?.textContent?.trim() || "";
              const isGuest =
                userText.toLowerCase().includes("invitado") ||
                userText.toLowerCase().includes("guest") ||
                userId === 1;

              let email: string | undefined;
              if (m?.cfg?.userEmail) email = m.cfg.userEmail;

              if (!email) {
                const mailtoEl = document.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null;
                if (mailtoEl?.href) {
                  email = mailtoEl.href.replace(/^mailto:/i, "").split("?")[0].trim();
                }
              }

              if (!email && userId > 1) {
                try {
                  const pRes = await fetch(`/user/profile.php?id=${userId}`);
                  const pHtml = await pRes.text();
                  const mMatch = /mailto:([a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9-]+\.)*uca\.edu\.ar)/i.exec(pHtml);
                  if (mMatch) email = mMatch[1];
                } catch {}
              }

              return {
                sesskey,
                userId,
                userName: userText,
                userEmail: email,
                isAuthenticated: Boolean(sesskey && (userId > 1 || (userText.length > 0 && !isGuest)))
              };
            });

            if (authInfo.isAuthenticated && authInfo.sesskey) {
              sesskey = authInfo.sesskey;
              userName = authInfo.userName || undefined;
              userEmail = authInfo.userEmail || undefined;
              console.log("¡Sesión autenticada en EVA detectada con éxito!");

              // Sincronizar Guaraní a través del portal de Autogestión
              try {
                console.log("Sincronizando sesión en SIU Guaraní vía Autogestión...");
                const guaraniPage = await context.newPage();

                // 1. Visitar /login en Autogestión para inicializar SSO y sesión del campus
                await guaraniPage.goto("https://autogestion.uca.edu.ar/login", {
                  timeout: 25000,
                  waitUntil: "domcontentloaded"
                }).catch(() => {});

                // 2. Navegar directamente a /guarani para emitir el ticket de Guaraní
                // Este endpoint redirige de forma directa a https://guarani.uca.edu.ar/academicos/inicio_alumno
                await guaraniPage.goto("https://autogestion.uca.edu.ar/guarani", {
                  timeout: 25000,
                  waitUntil: "domcontentloaded"
                }).catch(() => {});

                // 3. Esperar que la redirección a Guaraní se complete y se emita la cookie
                for (let i = 0; i < 10; i++) {
                  const cookies = await context.cookies();
                  const siuCookie = cookies.find((c) => c.name.startsWith("siu_sess"));
                  if (siuCookie) {
                    siuSession = siuCookie.value;
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 1000));
                }

                // 4. Descartar propuestas auxiliares y seleccionar carrera real directamente en la página
                try {
                  const carrerasInfo = await guaraniPage
                    .evaluate(() => {
                      const NON_DEGREE = /tutor|ingreso|bachiller/i;
                      const links = Array.from(
                        document.querySelectorAll("a.js-select-carreras")
                      ) as HTMLAnchorElement[];
                      const all = links
                        .map((l) => ({
                          id: l.getAttribute("data-carrera-id") || "",
                          nombre: l.innerText.replace(/\s+/g, " ").trim()
                        }))
                        .filter((c) => c.id && c.nombre);

                      const validas = all.filter((c) => !NON_DEGREE.test(c.nombre));
                      if (validas.length === 1) {
                        const target = links.find((l) => l.getAttribute("data-carrera-id") === validas[0].id);
                        if (target) target.click();
                      }
                      return { all, validas };
                    })
                    .catch(() => null);

                  if (carrerasInfo && carrerasInfo.all.length > 0) {
                    carrerasDisponibles = carrerasInfo.validas.length > 0 ? carrerasInfo.validas : carrerasInfo.all;
                    if (carrerasInfo.validas.length === 1) {
                      carreraActiva = carrerasInfo.validas[0].nombre;
                      console.log(`Carrera académica detectada y seleccionada: ${carreraActiva}`);
                    } else if (carrerasInfo.validas.length > 1) {
                      console.log(
                        `Múltiples carreras detectadas: ${carrerasInfo.validas.map((c) => c.nombre).join(", ")}`
                      );
                    }
                  }
                  await new Promise((r) => setTimeout(r, 1500));
                } catch {}

                // 5. Verificación final de cookie siu_sess
                if (!siuSession) {
                  const allCookies = await context.cookies();
                  const siuCookie = allCookies.find((c) => c.name.startsWith("siu_sess"));
                  if (siuCookie) siuSession = siuCookie.value;
                }

                if (siuSession) {
                  console.log("¡Sesión en SIU Guaraní vinculada con éxito!");
                } else {
                  console.warn("[AVISO] No se detectó cookie siu_sess en Autogestión.");
                }

                const campusCookie = (await context.cookies()).find(
                  (c) => c.name === "uca_campus_autogestion_session" || c.name.includes("campus_autogestion")
                );
                campusSession = campusCookie ? campusCookie.value : undefined;
                if (campusCookie) {
                  console.log("¡Sesión en Campus Autogestión vinculada con éxito!");
                }

                await guaraniPage.close();
              } catch (err) {
                logger.warn(`No se pudo sincronizar automáticamente Guaraní en este turno: ${err}`);
              }

              // Guardar cookies capturadas en el jar persistente (estrictamente pertenecientes a uca.edu.ar)
              const allContextCookies = await context.cookies();
              const storedCookies: StoredCookie[] = allContextCookies
                .filter((c) => c.domain.endsWith(".uca.edu.ar") || c.domain === "uca.edu.ar")
                .map((c) => ({
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path,
                  expires: c.expires
                }));

              // Guardar sesión cifrada con AES-256-GCM + Llavero del SO y registrar en auditoría
              saveEncryptedSession(
                {
                  cookies: storedCookies,
                  moodleSession,
                  sesskey,
                  siuSession,
                  campusSession,
                  userEmail,
                  userName,
                  carreraActiva,
                  carrerasDisponibles,
                  savedAt: new Date().toISOString()
                },
                true
              );

              console.log("==================================================");
              console.log(" Sesión guardada y cifrada con éxito en session.enc");
              console.log(` Usuario: ${userName || userEmail || "Estudiante UCA"}`);
              if (userEmail) console.log(` Email: ${userEmail}`);
              if (!siuSession) {
                console.log(" [AVISO] Guaraní no pudo sincronizarse por completo. Podés volver a correr 'login' si necesitás finales.");
              } else {
                console.log(" EVA Moodle y SIU Guaraní vinculados correctamente.");
              }
              console.log(" Ya podés cerrar el navegador y comenzar a usar el MCP.");
              console.log("==================================================");
              completed = true;
              break;
            }
          } catch {
            // El DOM puede estar navegando o recargando
          }
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (completed) {
      loginStatus = {
        estado: "exitoso",
        iniciadoEn: loginStatus.iniciadoEn,
        finalizadoEn: new Date().toISOString()
      };
    } else if (windowClosed) {
      loginStatus = {
        estado: "cancelado",
        iniciadoEn: loginStatus.iniciadoEn,
        finalizadoEn: new Date().toISOString(),
        error: "El usuario cerró la ventana del navegador antes de completar la autenticación."
      };
    } else {
      loginStatus = {
        estado: "timeout",
        iniciadoEn: loginStatus.iniciadoEn,
        finalizadoEn: new Date().toISOString(),
        error: "Se agotó el tiempo de espera de 5 minutos sin detectar una sesión autenticada en EVA."
      };
    }

    activeContexts.delete(context);
    await context.close();
  } catch (err) {
    loginStatus = {
      estado: "fallido",
      iniciadoEn: loginStatus.iniciadoEn,
      finalizadoEn: new Date().toISOString(),
      error: String(err)
    };
    logger.error("Error durante el flujo de inicio de sesión", err);
    console.error("Fallo durante el inicio de sesión:", err);
  } finally {
    releaseLock();
  }
}
