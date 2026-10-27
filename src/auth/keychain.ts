import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CONFIG } from "../config.js";

let cachedMasterKey: Buffer | null = null;
let activeKeychainMode: string | null = null;

export function clearCachedMasterKey(): void {
  cachedMasterKey = null;
  activeKeychainMode = null;
}

// Obtiene o genera la clave AES-256 (32 bytes) protegida por el llavero del SO
export function getOrCreateMasterKey(): Buffer {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  let key: Buffer;
  if (process.platform === "win32") {
    key = getWindowsKey();
  } else if (process.platform === "darwin") {
    key = getMacKey();
  } else {
    key = getLinuxKey();
  }

  cachedMasterKey = key;
  return key;
}

// Elimina la clave maestra almacenada en el llavero del SO
export function deleteMasterKey(): void {
  cachedMasterKey = null;
  activeKeychainMode = null;
  if (process.platform === "win32") {
    const keyFile = path.join(CONFIG.BASE_DIR, "session.key");
    if (fs.existsSync(keyFile)) {
      try {
        fs.unlinkSync(keyFile);
      } catch {}
    }
  } else if (process.platform === "darwin") {
    try {
      execFileSync("security", ["delete-generic-password", "-s", "uca-mcp", "-a", "session-key"], { timeout: 3000 });
    } catch {}
  } else {
    try {
      execFileSync("secret-tool", ["clear", "service", "uca-mcp", "account", "session-key"], { timeout: 3000 });
    } catch {}
  }
}

// Retorna el mecanismo de resguardo criptográfico activo en la plataforma
export function getKeychainMode(): string {
  if (activeKeychainMode) {
    return activeKeychainMode;
  }
  if (process.platform === "win32") {
    return "windows-dpapi";
  }
  if (process.platform === "darwin") {
    return "macos-keychain";
  }
  try {
    execFileSync("which", ["secret-tool"], { stdio: "ignore" });
    return "linux-secretservice";
  } catch {
    return "degraded-machine-id";
  }
}

function getWindowsKey(): Buffer {
  const sysPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const keyFile = path.join(CONFIG.BASE_DIR, "session.key");

  if (fs.existsSync(keyFile)) {
    try {
      const encB64 = fs.readFileSync(keyFile, "utf8").trim();
      const script = `
        [Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
        $inputStr = [Console]::In.ReadToEnd().Trim()
        $bytes = [Convert]::FromBase64String($inputStr)
        $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Convert]::ToBase64String($dec)
      `;
      const plainB64 = execFileSync(
        sysPowerShell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { input: encB64, encoding: "utf8", timeout: 5000 }
      ).trim();
      activeKeychainMode = "windows-dpapi";
      return Buffer.from(plainB64, "base64");
    } catch (e: any) {
      throw new Error(`Error al descifrar la clave maestra DPAPI existente en ${keyFile}: ${e?.message || String(e)}`);
    }
  }

  // Generar nueva clave de 32 bytes y cifrarla con DPAPI pasando el secreto por stdin (no en argv)
  try {
    const rawKey = crypto.randomBytes(32);
    const rawB64 = rawKey.toString("base64");
    const protectScript = `
      [Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
      $inputStr = [Console]::In.ReadToEnd().Trim()
      $bytes = [Convert]::FromBase64String($inputStr)
      $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($enc)
    `;
    const encB64 = execFileSync(
      sysPowerShell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", protectScript],
      { input: rawB64, encoding: "utf8", timeout: 5000 }
    ).trim();

    fs.writeFileSync(keyFile, encB64, { encoding: "utf8", mode: 0o600 });
    activeKeychainMode = "windows-dpapi";
    return rawKey;
  } catch {
    // Fallback de contingencia si PowerShell se encuentra en Constrained Language Mode (CLM)
    activeKeychainMode = "windows-scrypt-clm";
    const userSid = process.env.USERNAME || os.userInfo().username;
    const salt = `uca-mcp-win-clm-${userSid}`;
    const machineGuid = process.env.COMPUTERNAME || "uca-win-machine";
    return crypto.scryptSync(machineGuid, salt, 32);
  }
}

function getMacKey(): Buffer {
  try {
    const stdout = execFileSync(
      "security",
      ["find-generic-password", "-s", "uca-mcp", "-a", "session-key", "-w"],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    activeKeychainMode = "macos-keychain";
    return Buffer.from(stdout, "hex");
  } catch (err: any) {
    // macOS 'security' devuelve exit code 44 (errSecItemNotFound) si la clave no existe en el llavero
    if (err?.status !== 44) {
      throw new Error(`Error al consultar el llavero de macOS: ${err?.message || String(err)}`);
    }
    const rawKey = crypto.randomBytes(32);
    // Usar 'security -i' por stdin para garantizar cero secretos en argv de 'ps aux'
    const command = `add-generic-password -s uca-mcp -a session-key -w ${rawKey.toString("hex")} -U\n`;
    execFileSync("security", ["-i"], { input: command, timeout: 3000 });
    activeKeychainMode = "macos-keychain";
    return rawKey;
  }
}

function getLinuxKey(): Buffer {
  if (process.env.UCA_PASSPHRASE) {
    activeKeychainMode = "linux-passphrase";
    const salt = `uca-mcp-passphrase-${os.userInfo().uid}`;
    return crypto.scryptSync(process.env.UCA_PASSPHRASE, salt, 32);
  }

  let itemNotFound = false;
  try {
    const stdout = execFileSync(
      "secret-tool",
      ["lookup", "service", "uca-mcp", "account", "session-key"],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    if (stdout) {
      activeKeychainMode = "linux-secretservice";
      return Buffer.from(stdout, "hex");
    }
    itemNotFound = true;
  } catch (err: any) {
    // secret-tool sale con código 1 y stdout vacío si no encuentra el secreto
    if (err?.status === 1 && !err?.stdout?.toString().trim()) {
      itemNotFound = true;
    } else if (err?.code === "ENOENT") {
      // secret-tool no instalado en el sistema (ej. Docker, CI mínimo o distro sin libsecret): continuar a fallback degradado
    } else {
      throw new Error(`Error al consultar SecretService en Linux: ${err?.message || String(err)}`);
    }
  }

  if (itemNotFound) {
    const rawKey = crypto.randomBytes(32);
    try {
      // Almacenar en GNOME Keyring / KWallet por stdin
      execFileSync(
        "secret-tool",
        ["store", "--label=UCA MCP Master Key", "service", "uca-mcp", "account", "session-key"],
        { input: rawKey.toString("hex"), timeout: 3000 }
      );
      activeKeychainMode = "linux-secretservice";
      return rawKey;
    } catch {
      // Fallback a clave derivada por machine-id + uid en entornos headless sin SecretService
    }
  }

  // Fallback con machine-id + uid
  activeKeychainMode = "degraded-machine-id";
  const machineIdPath = fs.existsSync("/etc/machine-id") ? "/etc/machine-id" : "/var/lib/dbus/machine-id";
  const machineId = fs.existsSync(machineIdPath) ? fs.readFileSync(machineIdPath, "utf8").trim() : "uca-fallback-id";
  const salt = `uca-mcp-${os.userInfo().uid}`;
  return crypto.scryptSync(machineId, salt, 32);
}
