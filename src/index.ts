import "./silence-stdout.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpStdoutStream } from "./silence-stdout.js";
import { createServer } from "./server.js";
import { releaseLock } from "./auth/session-store.js";
import { flushPendingSessionSave } from "./auth/session.js";
import { closeAllActiveContexts } from "./auth/browser-driver.js";
import { logger } from "./shared/logger.js";
import { initStorage } from "./config.js";

async function main() {
  initStorage();
  const server = createServer();
  const transport = new StdioServerTransport(process.stdin, mcpStdoutStream);

  let isCleaningUp = false;
  const cleanup = async (code = 0) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      flushPendingSessionSave();
      await closeAllActiveContexts();
    } catch {}
    releaseLock();
    process.exit(code);
  };

  // Prevención de procesos huérfanos cuando el cliente cierra el pipe
  process.stdin.on("close", () => void cleanup(0));
  process.stdin.on("end", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(143));
  process.on("SIGINT", () => void cleanup(130));
  process.on("SIGHUP", () => void cleanup(129));

  process.on("uncaughtException", async (err) => {
    logger.error("Excepción no controlada", err);
    await cleanup(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Promesa rechazada no controlada", reason);
  });

  await server.connect(transport);

  // Pre-calentamiento proactivo en background si ya hay sesión guardada
  setTimeout(() => {
    import("./auth/session.js").then(({ loadEncryptedSession }) => {
      const session = loadEncryptedSession();
      if (session?.moodleSession) {
        import("./eva/client.js").then(({ getMaterias }) => {
          getMaterias(false).catch(() => {});
        }).catch(() => {});
      }
      if (session?.siuSession) {
        import("./guarani/client.js").then(({ ensureCarreraActiva, prefetchPlanGraph }) => {
          ensureCarreraActiva().then(() => prefetchPlanGraph()).catch(() => {});
        }).catch(() => {});
      }
    }).catch(() => {});
  }, 1500);

  // Keepalive periódico cada 15 min para evitar vencimiento por inactividad sin demorar la salida del proceso
  const keepAliveTimer = setInterval(() => {
    import("./shared/http.js").then(({ pingKeepAlive }) => {
      pingKeepAlive().catch(() => {});
    }).catch(() => {});
  }, 15 * 60 * 1000);
  keepAliveTimer.unref();
}

main().catch(async (err) => {
  logger.error("Fallo al iniciar servidor MCP", err);
  try {
    flushPendingSessionSave();
    await closeAllActiveContexts();
  } catch {}
  releaseLock();
  process.exit(1);
});
