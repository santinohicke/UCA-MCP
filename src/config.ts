import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function getBaseDir(): string {
  if (process.env.UCA_MCP_STORAGE_DIR) {
    return process.env.UCA_MCP_STORAGE_DIR;
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "uca-mcp");
  } else if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "uca-mcp");
  } else {
    const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    return path.join(xdgState, "uca-mcp");
  }
}

function getPackageVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "uca-mcp" && pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {}
  return "0.0.0";
}

const PACKAGE_VERSION = getPackageVersion();

export const CONFIG = {
  VERSION: PACKAGE_VERSION,
  get BASE_DIR() {
    return getBaseDir();
  },
  get ENCRYPTED_SESSION_PATH() {
    return path.join(this.BASE_DIR, "session.enc");
  },
  get LOCKFILE_PATH() {
    return path.join(this.BASE_DIR, "profile.lock");
  },
  get BROWSER_PROFILE_DIR() {
    return path.join(this.BASE_DIR, "browser-profile");
  },
  get AUDIT_LOG_PATH() {
    return path.join(this.BASE_DIR, "audit.log");
  },
  get STAGING_DIR() {
    return path.join(this.BASE_DIR, "staging");
  },
  get CACHE_DIR() {
    return path.join(this.BASE_DIR, "cache");
  },
  get CERTIFICADOS_DIR() {
    return path.join(this.BASE_DIR, "certificados");
  },

  EVA_BASE_URL: "https://eva.uca.edu.ar",
  GUARANI_BASE_URL: "https://guarani.uca.edu.ar/academicos",
  CAMPUS_BASE_URL: "https://autogestion.uca.edu.ar",
  MICROSOFT_LOGIN_URL: "https://login.microsoftonline.com/ucao365.onmicrosoft.com",

  MAX_AUDIT_LOG_SIZE: 5 * 1024 * 1024, // 5 MB

  get HABILITAR_ESCRITURA(): boolean {
    const val = process.env.UCA_HABILITAR_ESCRITURA;
    return val !== "false" && val !== "0";
  }
};

let storageInitialized = false;
const ONE_HOUR = 60 * 60 * 1000;
const CACHE_MAX_BYTES = 300 * 1024 * 1024;

// Asegura existencia de carpetas locales y purga staging al arrancar (se ejecuta una única vez por proceso)
export function initStorage(force = false): void {
  if (storageInitialized && !force) return;
  storageInitialized = true;
  if (!fs.existsSync(CONFIG.BASE_DIR)) {
    fs.mkdirSync(CONFIG.BASE_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Purgar archivos temporales huérfanos de sesión en BASE_DIR
    try {
      for (const file of fs.readdirSync(CONFIG.BASE_DIR)) {
        if (/^session\.enc\..*\.tmp$/.test(file)) {
          try {
            const fp = path.join(CONFIG.BASE_DIR, file);
            // Solo huérfanos viejos: otro cliente MCP abierto podría estar escribiendo ahora
            if (Date.now() - fs.statSync(fp).mtimeMs > ONE_HOUR) fs.unlinkSync(fp);
          } catch {}
        }
      }
    } catch {}
  }
  if (!fs.existsSync(CONFIG.STAGING_DIR)) {
    fs.mkdirSync(CONFIG.STAGING_DIR, { recursive: true, mode: 0o700 });
  } else {
    try {
      const files = fs.readdirSync(CONFIG.STAGING_DIR);
      for (const file of files) {
        try {
          const fp = path.join(CONFIG.STAGING_DIR, file);
          if (Date.now() - fs.statSync(fp).mtimeMs > ONE_HOUR) fs.rmSync(fp, { recursive: true, force: true });
        } catch {}
      }
    } catch {}
  }
  if (!fs.existsSync(CONFIG.CERTIFICADOS_DIR)) {
    fs.mkdirSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Purgar certificados descargados mayores a 7 días (TTL)
    try {
      const maxAge = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const file of fs.readdirSync(CONFIG.CERTIFICADOS_DIR)) {
        const filePath = path.join(CONFIG.CERTIFICADOS_DIR, file);
        try {
          if (now - fs.statSync(filePath).mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
    } catch {}
  }
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Purgar caché mayor a 30 días (excepto correlativas_*) y limitar el tamaño total (borra lo más viejo primero)
    try {
      const maxAge = 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const entries: { fp: string; size: number; mtime: number; keep: boolean }[] = [];
      for (const file of fs.readdirSync(CONFIG.CACHE_DIR)) {
        const filePath = path.join(CONFIG.CACHE_DIR, file);
        try {
          const st = fs.statSync(filePath);
          if (!st.isFile()) continue;
          const keep = file.startsWith("correlativas_");
          if (!keep && now - st.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            continue;
          }
          entries.push({ fp: filePath, size: st.size, mtime: st.mtimeMs, keep });
        } catch {}
      }
      let total = entries.reduce((a, e) => a + e.size, 0);
      if (total > CACHE_MAX_BYTES) {
        entries.sort((x, y) => x.mtime - y.mtime);
        for (const e of entries) {
          if (total <= CACHE_MAX_BYTES) break;
          if (e.keep) continue;
          try {
            fs.unlinkSync(e.fp);
            total -= e.size;
          } catch {}
        }
      }
    } catch {}
  }
}
