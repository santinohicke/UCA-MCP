import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { CONFIG } from "../../config.js";
import { evaFetch } from "../http.js";
import { getOrCreateMasterKey } from "../../auth/keychain.js";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB límite de seguridad

const fileCache = new Map<string, { result: DownloadResult; expires: number }>();

export interface DownloadResult {
  buffer: Uint8Array;
  mimeType: string;
  filename: string;
}

// Descarga un archivo de EVA con validación estricta de HTTPS, host, redirecciones seguras y caché persistente
export async function downloadSecureFile(fileUrl: string, depth = 0, forzarRefresco = false): Promise<DownloadResult> {
  if (!forzarRefresco) {
    const cached = fileCache.get(fileUrl);
    if (cached && Date.now() < cached.expires) {
      return cached.result;
    }
  }

  // Comprobar caché persistente cifrada en disco (TTL 24 horas, AES-256-GCM)
  const cacheKey = crypto.createHash("sha256").update(fileUrl).digest("hex");
  const cacheMetaPath = path.join(CONFIG.CACHE_DIR, `${cacheKey}.json`);
  const cacheDataPath = path.join(CONFIG.CACHE_DIR, `${cacheKey}.bin`);
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  if (!forzarRefresco && fs.existsSync(cacheMetaPath) && fs.existsSync(cacheDataPath)) {
    try {
      const stat = fs.statSync(cacheDataPath);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        const meta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
        const raw = fs.readFileSync(cacheDataPath);
        if (raw.length >= 28) {
          const key = getOrCreateMasterKey();
          const iv = raw.subarray(0, 12);
          const authTag = raw.subarray(12, 28);
          const ciphertext = raw.subarray(28);
          const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          const res: DownloadResult = { buffer: new Uint8Array(decrypted), mimeType: meta.mimeType, filename: meta.filename };
          if (decrypted.length <= 2 * 1024 * 1024) {
            if (fileCache.size >= 5) {
              const oldest = fileCache.keys().next().value;
              if (oldest) fileCache.delete(oldest);
            }
            fileCache.set(fileUrl, { result: res, expires: Date.now() + 60 * 60 * 1000 });
          }
          return res;
        }
      } else {
        // Expirado: limpiar
        try { fs.unlinkSync(cacheMetaPath); } catch {}
        try { fs.unlinkSync(cacheDataPath); } catch {}
      }
    } catch {
      try { fs.unlinkSync(cacheMetaPath); } catch {}
      try { fs.unlinkSync(cacheDataPath); } catch {}
    }
  }

  let currentUrl = fileUrl;
  let response: Response | null = null;
  const maxRedirects = 3;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl, CONFIG.EVA_BASE_URL);

    // Si es un recurso Moodle, solicitar redirección directa al archivo
    if (parsed.pathname === "/mod/resource/view.php" && !parsed.searchParams.has("redirect")) {
      parsed.searchParams.set("redirect", "1");
    }

    // 1. Host y protocolo estrictos: solo https://eva.uca.edu.ar
    if (parsed.protocol !== "https:" || parsed.origin !== new URL(CONFIG.EVA_BASE_URL).origin) {
      throw new Error(
        `Acceso denegado: solo se permiten descargas HTTPS desde ${CONFIG.EVA_BASE_URL}. Destino no permitido: '${parsed.origin}'`
      );
    }

    // 2. Ruta permitida (restringida a pluginfile.php y vistas de recursos/carpetas)
    const isAllowedPath =
      parsed.pathname.startsWith("/pluginfile.php") ||
      parsed.pathname === "/mod/resource/view.php" ||
      parsed.pathname === "/mod/folder/view.php";

    if (!isAllowedPath) {
      throw new Error(
        `Ruta no autorizada para descarga: '${parsed.pathname}'. Solo se permiten '/pluginfile.php', '/mod/resource/view.php' y '/mod/folder/view.php'.`
      );
    }

    // Timeout extendido de 120s para la conexión y streaming del cuerpo completo
    response = await evaFetch(parsed.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(120000)
    });

    // Manejo de redirecciones internas verificando cada salto contra la allowlist
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirección sin cabecera 'Location' en ${currentUrl}`);
      }
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    break;
  }

  if (!response || !response.ok) {
    throw new Error(`Error al descargar archivo: HTTP ${response?.status || "sin respuesta"}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`El archivo excede el tamaño máximo permitido de 25 MB.`);
  }

  // Lectura en streaming para abortar de inmediato si se excede el límite
  const reader = response.body?.getReader();
  let buffer: Uint8Array;

  if (reader) {
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.length;
        if (receivedBytes > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new Error("El archivo excede el tamaño máximo permitido de 25 MB.");
        }
        chunks.push(value);
      }
    }

    buffer = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("El archivo excede el tamaño máximo permitido de 25 MB.");
    }
    buffer = new Uint8Array(arrayBuffer);
  }

  const mimeType = response.headers.get("content-type") || "application/octet-stream";

  // Manejo de respuestas HTML para carpetas (/mod/folder) o recursos embebidos (/mod/resource)
  if (mimeType.includes("text/html")) {
    const htmlText = new TextDecoder().decode(buffer);
    const $h = cheerio.load(htmlText);

    if (new URL(currentUrl).pathname.includes("/mod/folder/view.php")) {
      const files: string[] = [];
      $h(".fp-filename, a[href*='/pluginfile.php']").each((_, el) => {
        const text = $h(el).text().trim();
        const href = $h(el).attr("href");
        if (text && href && !files.some((f) => f.includes(href))) {
          files.push(`- ${text} -> ${href}`);
        }
      });
      const listingText = files.length > 0
        ? `Contenido de la carpeta en EVA:\n\n${files.join("\n")}`
        : "La carpeta en EVA se encuentra vacía o no contiene archivos descargables.";
      const listingBuf = new TextEncoder().encode(listingText);
      return {
        buffer: listingBuf,
        mimeType: "text/plain",
        filename: "carpeta_archivos.txt"
      };
    }

    const embeddedLink = $h(
      "iframe[src*='/pluginfile.php'], object[data*='/pluginfile.php'], .resourcecontent a[href*='/pluginfile.php'], .resourceworkaround a[href*='/pluginfile.php']"
    ).first();
    const subUrl = embeddedLink.attr("src") || embeddedLink.attr("data") || embeddedLink.attr("href");
    if (subUrl) {
      if (depth >= 2) throw new Error("Límite de recursión alcanzado al resolver recurso embebido.");
      return downloadSecureFile(subUrl, depth + 1, forzarRefresco);
    }
  }

  const disposition = response.headers.get("content-disposition") || "";
  const filenameMatch = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(disposition);

  let filename = "archivo";
  if (filenameMatch) {
    try {
      filename = decodeURIComponent(filenameMatch[1]);
    } catch {
      filename = filenameMatch[1];
    }
  } else {
    filename = new URL(currentUrl).pathname.split("/").pop() || "archivo";
  }

  const result: DownloadResult = {
    buffer,
    mimeType,
    filename
  };

  // Guardar en caché persistente cifrada en disco (AES-256-GCM)
  try {
    if (!fs.existsSync(CONFIG.CACHE_DIR)) {
      fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    const key = getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, encrypted]);

    fs.writeFileSync(cacheMetaPath, JSON.stringify({ mimeType, filename }), "utf8");
    fs.writeFileSync(cacheDataPath, payload);
  } catch {}

  // Mantener caché en RAM solo para archivos livianos (<= 2 MB) y acotada a 5 entradas
  if (buffer.length <= 2 * 1024 * 1024) {
    if (fileCache.size >= 5) {
      const oldest = fileCache.keys().next().value;
      if (oldest) fileCache.delete(oldest);
    }
    fileCache.set(fileUrl, { result, expires: Date.now() + 60 * 60 * 1000 });
  }

  return result;
}
