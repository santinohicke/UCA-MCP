#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const options = {
  help: { type: "boolean" as const, short: "h" },
  version: { type: "boolean" as const, short: "v" },
  "keep-browser": { type: "boolean" as const }
};

const { values, positionals } = parseArgs({
  options,
  allowPositionals: true,
  strict: false
});

const command = positionals[0];

async function main() {
  if (values.version || command === "version" || command === "-v" || command === "--version") {
    const { CONFIG } = await import("../src/config.js");
    console.log(`v${CONFIG.VERSION}`);
    process.exit(0);
  }

  const unknownFlags = Object.keys(values).filter(
    (k) => k !== "help" && k !== "version" && k !== "keep-browser"
  );
  if (unknownFlags.length > 0) {
    console.error(`Opción desconocida: --${unknownFlags[0]}. Ejecutá 'uca-mcp --help' para ver opciones.`);
    process.exit(1);
  }

  if (values.help || command === "help" || command === "-h" || command === "--help") {
    const { CONFIG } = await import("../src/config.js");
    console.log(`
UCA MCP - Servidor y Utilidades CLI (v${CONFIG.VERSION})

Uso:
  uca-mcp [comando]

Comandos:
  serve                 Inicia el servidor en modo STDIO (por defecto para Claude/Cursor)
  doctor                Diagnostica el entorno, permisos y rutas
  login                 Abre el navegador interactivo para iniciar sesión institucional
  status                Consulta el estado de la sesión guardada
  logout                Purga sesión, claves del llavero, caché y navegador (--keep-browser para conservar navegador)
  setup [cliente]       Configura automáticamente tu cliente (claude, cursor, vscode, all)
  help                  Muestra esta ayuda
`);
    process.exit(0);
  }

  if (!command || command === "serve") {
    // Modo STDIO del servidor MCP: silence-stdout se importa dentro de index.js
    await import("../src/index.js");
  } else if (command === "doctor") {
    const { CONFIG, initStorage } = await import("../src/config.js");
    const { loadEncryptedSession } = await import("../src/auth/session.js");
    const { getKeychainMode } = await import("../src/auth/keychain.js");
    const { getAvailableChannel } = await import("../src/auth/browser-driver.js");
    const { getConfirmationTool } = await import("../src/shared/native-confirm.js");
    initStorage();
    const session = loadEncryptedSession();

    let browserStr = "Buscando...";
    try {
      const channel = await getAvailableChannel();
      browserStr = channel;
    } catch (e: any) {
      browserStr = `No detectado (${e.message})`;
    }

    const checkPing = async (url: string) => {
      const start = Date.now();
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        return `OK (${res.status}, ${Date.now() - start}ms)`;
      } catch (e: any) {
        return `Inaccesible (${e.message || "timeout"})`;
      }
    };

    console.log("=== Diagnóstico de UCA MCP ===");
    console.log(`Versión:           ${CONFIG.VERSION}`);
    console.log(`Node.js:           ${process.version}`);
    console.log(`Plataforma:        ${process.platform} (${process.arch})`);
    console.log(`Llavero / Modo:    ${getKeychainMode()}`);
    if (getKeychainMode() === "windows-scrypt-clm") {
      console.warn("⚠️  [ADVERTENCIA] PowerShell CLM activo: la clave se deriva del entorno local en vez de DPAPI.");
    }
    console.log(`Navegador:         ${browserStr}`);
    console.log(`Diálogo Nativo:    ${getConfirmationTool()}`);
    console.log(`Carpeta de Estado: ${CONFIG.BASE_DIR}`);
    console.log(`Sesión Cifrada:    ${session ? `Activa (${session.userEmail || "guardada"})` : "No iniciada"}`);
    console.log("--- Conectividad Institucional ---");
    console.log(`EVA (Moodle):      ${await checkPing(CONFIG.EVA_BASE_URL)}`);
    console.log(`Guaraní (SIU):     ${await checkPing(CONFIG.GUARANI_BASE_URL)}`);
    console.log(`Campus UCA:        ${await checkPing(CONFIG.CAMPUS_BASE_URL)}`);
    console.log("===============================");
  } else if (command === "status") {
    const { loadEncryptedSession } = await import("../src/auth/session.js");
    const session = loadEncryptedSession();
    if (session) {
      console.log(`Sesión activa para: ${session.userEmail || "estudiante"}`);
      console.log(`Fecha de guardado:  ${session.savedAt}`);
    } else {
      console.log("No hay una sesión activa guardada.");
    }
  } else if (command === "login") {
    const { getKeychainMode } = await import("../src/auth/keychain.js");
    if (getKeychainMode() === "degraded-machine-id") {
      console.warn("⚠️  [ADVERTENCIA DE SEGURIDAD]");
      console.warn("Entorno Linux sin Secret Service (libsecret/GNOME Keyring).");
      console.warn("La clave de cifrado local se deriva de machine-id y UID del sistema.");
      console.warn("Para aislar la sesión en entornos multiusuario, definí la variable de entorno UCA_PASSPHRASE.\n");
    }
    const { runLogin } = await import("../src/auth/browser-driver.js");
    const ok = await runLogin();
    if (!ok) process.exitCode = 1;
  } else if (command === "logout") {
    const { clearSession } = await import("../src/auth/session.js");
    const { deleteMasterKey } = await import("../src/auth/keychain.js");
    const { CONFIG } = await import("../src/config.js");
    const fs = await import("node:fs");

    clearSession();
    deleteMasterKey();

    const keepBrowser = Boolean(values["keep-browser"] || positionals.includes("--keep-browser") || process.argv.includes("--keep-browser"));
    if (!keepBrowser) {
      if (fs.existsSync(CONFIG.BROWSER_PROFILE_DIR)) {
        try { fs.rmSync(CONFIG.BROWSER_PROFILE_DIR, { recursive: true, force: true }); } catch {}
      }
      if (fs.existsSync(CONFIG.CACHE_DIR)) {
        try { fs.rmSync(CONFIG.CACHE_DIR, { recursive: true, force: true }); } catch {}
      }
      if (fs.existsSync(CONFIG.CERTIFICADOS_DIR)) {
        try { fs.rmSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, force: true }); } catch {}
      }
      if (fs.existsSync(CONFIG.AUDIT_LOG_PATH)) {
        try { fs.unlinkSync(CONFIG.AUDIT_LOG_PATH); } catch {}
      }
      console.log("Sesión, claves maestras, perfil de navegador (SSO cookies), certificados y caché purgados por completo.");
    } else {
      console.log("Sesión local y clave de cifrado purgadas. Perfil de navegador conservado (--keep-browser).");
    }
  } else if (command === "setup") {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { CONFIG } = await import("../src/config.js");

    const targetClient = (positionals[1] || "all").toLowerCase();
    console.log(`Configurando UCA MCP para: ${targetClient}...`);

    let mcpEntry: { command: string; args: string[] };
    const isNpx = __dirname.includes("_npx") || __dirname.includes("npm-cache");

    if (isNpx) {
      mcpEntry = {
        command: "uca-mcp",
        args: ["serve"]
      };
      console.log("[INFO] Configurado con comando global 'uca-mcp'. Recordá tenerlo instalado con: npm install -g uca-mcp");
    } else {
      const entryScript = path.resolve(__dirname, "cli.js");
      mcpEntry = {
        command: process.execPath,
        args: [entryScript, "serve"]
      };
    }

    // 1. Claude Desktop
    if (targetClient === "claude" || targetClient === "all") {
      let claudeConfigDir = "";
      if (process.platform === "win32") {
        claudeConfigDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude");
      } else if (process.platform === "darwin") {
        claudeConfigDir = path.join(os.homedir(), "Library", "Application Support", "Claude");
      } else {
        claudeConfigDir = path.join(os.homedir(), ".config", "Claude");
      }

      const claudeConfigFile = path.join(claudeConfigDir, "claude_desktop_config.json");
      try {
        if (!fs.existsSync(claudeConfigDir)) {
          fs.mkdirSync(claudeConfigDir, { recursive: true });
        }
        let config: Record<string, any> = { mcpServers: {} };
        if (fs.existsSync(claudeConfigFile)) {
          config = JSON.parse(fs.readFileSync(claudeConfigFile, "utf8"));
          if (!config.mcpServers) config.mcpServers = {};
        }
        config.mcpServers["uca"] = mcpEntry;
        fs.writeFileSync(claudeConfigFile, JSON.stringify(config, null, 2), "utf8");
        console.log(`[OK] Claude Desktop configurado en: ${claudeConfigFile}`);
      } catch (err) {
        console.warn(`[AVISO] No se pudo escribir configuración de Claude Desktop: ${err}`);
      }
    }

    // 2. Cursor
    if (targetClient === "cursor" || targetClient === "all") {
      const cursorDir = path.join(os.homedir(), ".cursor");
      const cursorConfigFile = path.join(cursorDir, "mcp.json");
      try {
        if (!fs.existsSync(cursorDir)) {
          fs.mkdirSync(cursorDir, { recursive: true });
        }
        let config: Record<string, any> = { mcpServers: {} };
        if (fs.existsSync(cursorConfigFile)) {
          config = JSON.parse(fs.readFileSync(cursorConfigFile, "utf8"));
          if (!config.mcpServers) config.mcpServers = {};
        }
        config.mcpServers["uca"] = mcpEntry;
        fs.writeFileSync(cursorConfigFile, JSON.stringify(config, null, 2), "utf8");
        console.log(`[OK] Cursor configurado en: ${cursorConfigFile}`);
      } catch (err) {
        console.warn(`[AVISO] No se pudo escribir configuración de Cursor: ${err}`);
      }
    }

    // 3. VS Code (solo si se especificó explícitamente o si ya existe la carpeta .vscode en cwd)
    const vscodeDir = path.join(process.cwd(), ".vscode");
    if (targetClient === "vscode" || (targetClient === "all" && fs.existsSync(vscodeDir))) {
      const vscodeConfigFile = path.join(vscodeDir, "mcp.json");
      try {
        if (!fs.existsSync(vscodeDir)) {
          fs.mkdirSync(vscodeDir, { recursive: true });
        }
        let config: Record<string, any> = { servers: {} };
        if (fs.existsSync(vscodeConfigFile)) {
          config = JSON.parse(fs.readFileSync(vscodeConfigFile, "utf8"));
          if (!config.servers) config.servers = {};
        }
        config.servers["uca"] = {
          type: "stdio",
          ...mcpEntry
        };
        fs.writeFileSync(vscodeConfigFile, JSON.stringify(config, null, 2), "utf8");
        console.log(`[OK] VS Code configurado en: ${vscodeConfigFile}`);
      } catch (err) {
        console.warn(`[AVISO] No se pudo escribir configuración de VS Code: ${err}`);
      }
    }

    console.log("Configuración completada. Ya podés reiniciar tu cliente de IA.");
  } else {
    console.error(`Comando desconocido: ${command}. Ejecutá 'uca-mcp --help' para ver opciones.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error fatal en CLI:", err);
  process.exit(1);
});
