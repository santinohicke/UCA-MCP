import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

export interface ConfirmDetails {
  titulo: string;
  accion: string;
  entidad: string;
  detalle: string;
}

export class UserDeniedError extends Error {
  constructor(message = "Operación cancelada por el usuario en el diálogo de autorización.") {
    super(message);
    this.name = "UserDeniedError";
  }
}

export class ConfirmationTimeoutError extends Error {
  constructor(message = "Confirmación expirada por timeout (45s sin respuesta del usuario).") {
    super(message);
    this.name = "ConfirmationTimeoutError";
  }
}

export class CooldownError extends Error {
  constructor(message = "Operación en pausa de seguridad preventiva tras un rechazo reciente.") {
    super(message);
    this.name = "CooldownError";
  }
}

// Delimita contenido provisto por terceros con un nonce aleatorio para neutralizar inyecciones de prompt
export function wrapUntrustedContent(text: string, source: string): string {
  const nonce = crypto.randomBytes(4).toString("hex");
  const cleanSource = source.replace(/["<>\r\n]/g, "").slice(0, 80);
  return `<<<UNTRUSTED_CONTENT_${nonce} fuente="${cleanSource}">>>\n${text}\n<<<END_UNTRUSTED_CONTENT_${nonce}>>>`;
}

// Desenvuelve contenido delimitado para búsquedas, comparaciones de igualdad e inspecciones internas
export function unwrapUntrustedContent(text: string): string {
  const match = /^<<<UNTRUSTED_CONTENT_[a-f0-9]+(?:\s+fuente="[^"]*")?>>>\r?\n([\s\S]*?)\r?\n<<<END_UNTRUSTED_CONTENT_[a-f0-9]+>>>$/.exec(text.trim());
  return match ? match[1] : text;
}

// Sanitiza cadenas para impedir distorsiones o inyecciones visuales en el diálogo nativo (limpia zero-width, bidi, soft-hyphen, tags Unicode y hangul filler)
export function sanitizeDialogText(text: string, maxLen = 1000, preserveNewlines = false): string {
  if (preserveNewlines) {
    return text
      .replace(/\r\n|\r/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\u{E0000}-\u{E007F}]/gu, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxLen);
  }
  return text
    .replace(/\r\n|\r|\n|\t/g, " ")
    .replace(/[\x00-\x1F\x7F-\x9F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\u{E0000}-\u{E007F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export interface ValidateUploadResult {
  valid: boolean;
  reason?: string;
  sizeBytes?: number;
  sha256?: string;
  realPath?: string;
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".txt", ".zip", ".rar", ".7z", ".c", ".cpp", ".h", ".py",
  ".java", ".cs", ".js", ".ts", ".html", ".css", ".md", ".csv"
]);

// Verifica si un archivo local es seguro para subir (lstat sin symlinks, realpath, allowlist de extensiones y hash)
export function validateUploadFile(filePath: string): ValidateUploadResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: "El archivo no existe en la ruta especificada." };
    }

    // 1. Rechazar symlinks
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
      return { valid: false, reason: "No se permiten enlaces simbólicos por razones de seguridad." };
    }

    if (!lstat.isFile()) {
      return { valid: false, reason: "La ruta indicada no corresponde a un archivo regular." };
    }

    // 2. Límite de tamaño máximo (25 MB)
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
    if (lstat.size > MAX_UPLOAD_BYTES) {
      return { valid: false, reason: "El archivo supera el tamaño máximo permitido de 25 MB para entregas." };
    }

    // 3. Realpath canónico
    const realPath = fs.realpathSync(filePath);
    const baseName = path.basename(realPath).toLowerCase();

    // 4. Allowlist de directorios raíz permitidos (Descargas, Documentos, Escritorio y OneDrive)
    const home = os.homedir();
    const candidateRoots = [
      path.join(home, "Downloads"),
      path.join(home, "Descargas"),
      path.join(home, "Documents"),
      path.join(home, "Documentos"),
      path.join(home, "Desktop"),
      path.join(home, "Escritorio"),
      path.join(home, "OneDrive"),
      path.join(home, "OneDrive - Universidad Católica Argentina")
    ];

    if (process.env.OneDrive) candidateRoots.push(process.env.OneDrive);
    if (process.env.OneDriveConsumer) candidateRoots.push(process.env.OneDriveConsumer);
    if (process.env.OneDriveCommercial) candidateRoots.push(process.env.OneDriveCommercial);

    // Permitir temporal solo en pruebas de entorno (previene compartir /tmp multiusuario en producción)
    if (process.env.NODE_ENV === "test" || process.env.UCA_ALLOW_TMP_UPLOAD === "1") {
      candidateRoots.push(os.tmpdir());
    }

    // Directorios adicionales configurables por el usuario para discos secundarios
    if (process.env.UCA_EXTRA_UPLOAD_DIRS) {
      const extraDirs = process.env.UCA_EXTRA_UPLOAD_DIRS.split(/[;,]/)
        .map((d) => d.trim())
        .filter(Boolean);
      candidateRoots.push(...extraDirs);
    }

    // Windows y macOS usan sistemas de archivos que no distinguen mayúsculas; en Linux sí
    const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";
    const normPath = (p: string) => (caseInsensitiveFs ? p.toLowerCase() : p);
    const allowedRoots = candidateRoots.map((r) => normPath(path.resolve(r)));

    const realPathResolved = normPath(path.resolve(realPath));
    const isInsideAllowed = allowedRoots.some(
      (root) => realPathResolved === root || realPathResolved.startsWith(root + path.sep)
    );

    if (!isInsideAllowed) {
      return {
        valid: false,
        reason: "Por seguridad, solo se permite subir archivos ubicados en Descargas, Documentos, Escritorio, OneDrive o carpetas autorizadas en UCA_EXTRA_UPLOAD_DIRS."
      };
    }

    // 5. Denylist estricta de nombres y credenciales
    const blockedNames = [
      ".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
      "credentials", "session.enc", "session.key", "profile.lock"
    ];

    if (blockedNames.some((b) => baseName === b || baseName.endsWith(".pem") || baseName.endsWith(".key"))) {
      return { valid: false, reason: "El archivo contiene información sensible o credenciales protegidas." };
    }

    // 4. Denegar archivos ocultos / dotfiles (.npmrc, .git-credentials, .bash_history, etc.)
    if (baseName.startsWith(".")) {
      return { valid: false, reason: "No se permite subir archivos ocultos o de configuración del sistema." };
    }

    // 5. Allowlist de extensiones permitidas
    const ext = path.extname(baseName);
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      return { valid: false, reason: `Extensión de archivo '${ext}' no permitida para entregas de tareas.` };
    }

    // 6. Sniffing de los primeros 4KB para detectar claves privadas
    const fd = fs.openSync(realPath, "r");
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
    fs.closeSync(fd);

    const head = buffer.subarray(0, bytesRead).toString("utf8");
    if (head.includes("-----BEGIN") && head.includes("PRIVATE KEY")) {
      return { valid: false, reason: "El archivo contiene una clave criptográfica privada." };
    }

    // 7. Calcular hash SHA-256 del archivo completo
    const fileBytes = fs.readFileSync(realPath);
    const sha256 = crypto.createHash("sha256").update(fileBytes).digest("hex");

    return { valid: true, sizeBytes: lstat.size, sha256, realPath };
  } catch (err) {
    return { valid: false, reason: `Error al acceder al archivo: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Mutex para serializar diálogos y evitar que se solapen popups concurrentes
let dialogQueue: Promise<unknown> = Promise.resolve();

// Timestamp hasta el cual las confirmaciones están en pausa tras un rechazo
let rejectionCooldownUntil = 0;
const REJECTION_COOLDOWN_MS = 30000; // 30 segundos

// Historial de prompts en ventana móvil de 1 hora para rate limiting
const promptHistory: number[] = [];
const MAX_PROMPTS_PER_HOUR = 10;

type DialogOutcome = "approved" | "denied" | "timeout" | "unavailable";

let elicitationHandler: ((details: ConfirmDetails) => Promise<boolean | null>) | null = null;

/**
 * Registra un manejador para Canal A (Elicitation MCP) si el cliente lo soporta.
 * Si retorna null, se realiza fallback al diálogo nativo (Canal B).
 */
export function setElicitationHandler(handler: ((details: ConfirmDetails) => Promise<boolean | null>) | null): void {
  elicitationHandler = handler;
}

/**
 * Resetea el cooldown y rate limiting de confirmaciones (útil para suites de tests)
 */
export function resetConfirmationCooldown(): void {
  rejectionCooldownUntil = 0;
  promptHistory.length = 0;
}

// Despliega un diálogo modal nativo del sistema operativo (Canal B) o Canal A si está disponible
export async function showNativeConfirmation(
  details: ConfirmDetails,
  onHeartbeat?: (tick?: number) => void | Promise<void>
): Promise<boolean> {
  const now = Date.now();

  // Cooldown tras rechazo previo para prevenir ataques de fatiga
  if (now < rejectionCooldownUntil) {
    const remainingSecs = Math.ceil((rejectionCooldownUntil - now) / 1000);
    throw new CooldownError(
      `Operación en pausa de seguridad preventiva tras un rechazo reciente (esperá ${remainingSecs}s para reintentar).`
    );
  }

  // Rate-limiting de prompts por hora
  const oneHourAgo = now - 3600000;
  while (promptHistory.length > 0 && promptHistory[0] < oneHourAgo) {
    promptHistory.shift();
  }
  if (promptHistory.length >= MAX_PROMPTS_PER_HOUR) {
    throw new Error(
      `Límite de seguridad alcanzado: se excedió el máximo de ${MAX_PROMPTS_PER_HOUR} confirmaciones nativas por hora.`
    );
  }

  // Verificación estricta de longitud: si el detalle excede la capacidad visual del diálogo, rechazar (fail-closed)
  if (details.detalle.length > 800) {
    throw new Error(
      `El detalle de la operación (${details.detalle.length} caracteres) excede el límite máximo auditable en pantalla (800 caracteres). Operación rechazada por seguridad.`
    );
  }

  // Serialización: solo un diálogo activo a la vez
  const run = async (): Promise<boolean> => {
    promptHistory.push(Date.now());

    let tickCount = 0;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    if (onHeartbeat) {
      heartbeatTimer = setInterval(async () => {
        try {
          tickCount++;
          await onHeartbeat(tickCount);
        } catch {}
      }, 4000);
    }

    try {
      const isHeadless = Boolean(
        process.env.CI ||
        process.env.HEADLESS ||
        (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === "linux")
      );
      const hasGui = !isHeadless;

      // Si hay entorno gráfico disponible, Canal B (diálogo modal del SO) es prioritario y obligatorio
      // para prevenir que el propio arnés del LLM auto-apruebe la acción
      if (hasGui) {
        const outcome = await spawnPlatformDialog(details);
        if (outcome === "approved") {
          return true;
        }
        if (outcome === "denied") {
          rejectionCooldownUntil = Date.now() + REJECTION_COOLDOWN_MS;
          return false;
        }
        if (outcome === "timeout") {
          rejectionCooldownUntil = Date.now() + REJECTION_COOLDOWN_MS;
          throw new ConfirmationTimeoutError("Confirmación expirada por timeout (45s sin respuesta del usuario).");
        }
        // outcome === "unavailable": fallback a Canal A abajo si está configurado
      }

      // Fallback a Canal A (Elicitation MCP) si no hay GUI o Canal B no estuvo disponible
      if (elicitationHandler) {
        try {
          const elicited = await elicitationHandler(details);
          if (elicited === true) {
            return true;
          }
          if (elicited === false) {
            rejectionCooldownUntil = Date.now() + REJECTION_COOLDOWN_MS;
            return false;
          }
        } catch (err: any) {
          if (err instanceof ConfirmationTimeoutError || err?.name === "ConfirmationTimeoutError") {
            rejectionCooldownUntil = Date.now() + REJECTION_COOLDOWN_MS;
            throw err;
          }
          // Fallback transparente si falla el transporte de elicitation
        }
      }

      if (!hasGui) {
        throw new Error("Entorno gráfico no disponible y el cliente MCP no soporta Elicitation para confirmar la acción.");
      }

      throw new Error("Entorno gráfico no disponible para confirmación en Canal B (falta zenity o sesión gráfica activa).");
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  };

  const currentRun = dialogQueue.then(run, run);
  dialogQueue = currentRun.catch(() => {});
  return currentRun;
}

// Reporta la herramienta gráfica disponible para confirmación en el sistema actual
export function getConfirmationTool(): string {
  if (process.platform === "win32") {
    return "Windows PowerShell (WScript.Shell Popup)";
  }
  if (process.platform === "darwin") {
    return "macOS osascript (display dialog)";
  }
  if (process.platform === "linux") {
    for (const tool of ["zenity", "kdialog", "yad"]) {
      try {
        const res = spawnSync("which", [tool], { stdio: "ignore" });
        if (res.status === 0) return `Linux ${tool}`;
      } catch {}
    }
  }
  return "Ninguna herramienta gráfica detectada (fail-closed o Elicitation)";
}

// Invocación a nivel de proceso del diálogo nativo del SO distinguiendo aprobado, denegado, timeout y no disponible
async function spawnPlatformDialog(details: ConfirmDetails): Promise<DialogOutcome> {
  const title = sanitizeDialogText(details.titulo, 80, false);
  const accion = sanitizeDialogText(details.accion, 100, false);
  const entidad = sanitizeDialogText(details.entidad, 100, false);
  const detalle = sanitizeDialogText(details.detalle, 800, true);
  const body = `Acción requerida: ${accion}\nDestino: ${entidad}\n\nDetalle:\n${detalle}\n\n¿Deseás autorizar esta operación?`;

  if (process.platform === "win32") {
    // Windows: System Modal Popup con Cancelar por defecto (48 + 1 + 256 + 4096 = 4401)
    const sysPowerShell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const script = `
      try {
        $sh = New-Object -ComObject WScript.Shell
        $res = $sh.Popup($env:UCA_MSG, 45, $env:UCA_TITLE, 4401)
        if ($res -eq 1) { exit 0 }
        elseif ($res -eq -1) { exit 2 }
        elseif ($res -eq 2) { exit 10 }
        else { exit 10 }
      } catch {
        exit 99
      }
    `;
    return new Promise((resolve) => {
      execFile(
        sysPowerShell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          env: { ...process.env, UCA_TITLE: title, UCA_MSG: body },
          timeout: 46000
        },
        (error) => {
          if (!error) return resolve("approved");
          if (error.code === 2 || error.killed) return resolve("timeout");
          if (error.code === 10) return resolve("denied");
          return resolve("unavailable");
        }
      );
    });
  } else if (process.platform === "darwin") {
    // macOS: osascript con argumentos argv aislados contra inyecciones
    const script = `
      on run argv
        set theTitle to item 1 of argv
        set theMsg to item 2 of argv
        set dialogResult to display dialog theMsg with title theTitle buttons {"Cancelar", "Confirmar"} default button "Cancelar" with icon caution giving up after 45
        if gave up of dialogResult is true then
          return "TIMEOUT"
        else if button returned of dialogResult is "Confirmar" then
          return "OK"
        else
          return "DENIED"
        end if
      end run
    `;
    return new Promise((resolve) => {
      execFile("osascript", ["-e", script, title, body], { timeout: 46000 }, (error, stdout) => {
        if (!error && stdout) {
          if (stdout.includes("OK")) return resolve("approved");
          if (stdout.includes("TIMEOUT")) return resolve("timeout");
        }
        if (error && (error as any).code === "ENOENT") return resolve("unavailable");
        resolve("denied");
      });
    });
  } else {
    // Linux: zenity, kdialog o yad con fail-closed en headless
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return "unavailable";
    }

    const tryExec = (cmd: string, args: string[], timeoutCode?: number): Promise<DialogOutcome> => {
      return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 46000 }, (error) => {
          if (!error) return resolve("approved");
          if ((error as any).code === "ENOENT") return resolve("unavailable");
          if (error.killed || (timeoutCode !== undefined && (error as any).code === timeoutCode)) {
            return resolve("timeout");
          }
          return resolve("denied");
        });
      });
    };

    // 1. Probar zenity
    const zenityRes = await tryExec(
      "zenity",
      ["--question", "--title", title, "--text", body, "--timeout=45", "--no-markup"],
      5
    );
    if (zenityRes !== "unavailable") return zenityRes;

    // 2. Probar kdialog (KDE)
    const kdialogRes = await tryExec("kdialog", ["--title", title, "--yesno", body]);
    if (kdialogRes !== "unavailable") return kdialogRes;

    // 3. Probar yad
    const yadRes = await tryExec(
      "yad",
      ["--question", "--title", title, "--text", body, "--timeout=45", "--no-markup", "--button=Cancelar:1", "--button=Confirmar:0"],
      70
    );
    return yadRes;
  }
}

// Despliega un selector de archivos nativo del SO para selección interactiva
export async function pickNativeFile(): Promise<string> {
  if (process.platform === "win32") {
    const sysPowerShell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const script = `
      try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        $f = New-Object System.Windows.Forms.OpenFileDialog
        $f.Title = "Seleccionar archivo para entrega en EVA UCA"
        $f.Filter = "Documentos (*.pdf;*.docx;*.txt;*.zip)|*.pdf;*.docx;*.txt;*.zip|Todos los archivos (*.*)|*.*"
        if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $f.FileName
        }
      } catch {
        exit 1
      }
    `;
    return new Promise((resolve) => {
      execFile(
        sysPowerShell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: 60000 },
        (error, stdout) => {
          resolve(!error && stdout.trim() ? stdout.trim() : "");
        }
      );
    });
  } else if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile(
        "osascript",
        ["-e", 'POSIX path of (choose file with prompt "Seleccionar archivo para entrega en EVA UCA:")'],
        { timeout: 60000 },
        (error, stdout) => {
          resolve(!error && stdout.trim() ? stdout.trim() : "");
        }
      );
    });
  } else {
    return new Promise((resolve) => {
      execFile(
        "zenity",
        ["--file-selection", "--title=Seleccionar archivo para entrega en EVA UCA"],
        { timeout: 60000 },
        (error, stdout) => {
          resolve(!error && stdout.trim() ? stdout.trim() : "");
        }
      );
    });
  }
}
