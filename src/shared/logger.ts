import fs from "node:fs";
import { CONFIG } from "../config.js";

const SENSITIVE_PATTERNS = [
  // Cabeceras y parámetros clave=valor o clave: valor
  /(?:MoodleSession[a-zA-Z0-9_-]*|siu_sess[a-zA-Z0-9_-]*|sesskey|__csrf|token|password|clave|authorization)\s*[:=]\s*[^\s,;&"'>]+/gi,
  // Formato JSON {"token": "...", "sesskey": "..."}
  /"(?:token|sesskey|password|clave|authorization|moodleSession|siuSession|campusSession)"\s*:\s*"[^"]+"/gi,
  // Tokens Bearer
  /Bearer\s+[a-zA-Z0-9_\-\.]+/gi
];

export function sanitizeSensitiveText(message: string): string {
  let result = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export const logger = {
  info(msg: string): void {
    process.stderr.write(`[UCA MCP INFO] ${sanitizeSensitiveText(msg)}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`[UCA MCP WARN] ${sanitizeSensitiveText(msg)}\n`);
  },
  error(msg: string, err?: unknown): void {
    const errorDetails = err instanceof Error ? ` - ${sanitizeSensitiveText(err.message)}` : "";
    process.stderr.write(`[UCA MCP ERROR] ${sanitizeSensitiveText(msg)}${errorDetails}\n`);
  },
  audit(action: string, details: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action,
        ...details
      }) + "\n";

      // Rotación simple si supera 5 MB
      if (fs.existsSync(CONFIG.AUDIT_LOG_PATH)) {
        const stats = fs.statSync(CONFIG.AUDIT_LOG_PATH);
        if (stats.size > CONFIG.MAX_AUDIT_LOG_SIZE) {
          const backupPath = `${CONFIG.AUDIT_LOG_PATH}.1`;
          fs.renameSync(CONFIG.AUDIT_LOG_PATH, backupPath);
        }
      }

      fs.appendFileSync(CONFIG.AUDIT_LOG_PATH, sanitizeSensitiveText(entry), { encoding: "utf8", mode: 0o600 });
    } catch {
      // No frenar la ejecución si falla el logging de auditoría
    }
  }
};
