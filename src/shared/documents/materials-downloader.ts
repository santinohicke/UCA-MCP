import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MaterialItem {
  curso?: string;
  seccion?: string;
  nombre: string;
  tipo: string; // resource | folder | otros (se ignoran)
  url?: string;
  // true si el nombre del recurso/sección coincide con la búsqueda (o no hay búsqueda).
  // En carpetas con coincide=false solo se bajan los archivos internos cuyo nombre coincide.
  coincide?: boolean;
}

export interface DownloadedFile {
  buffer: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface MaterialsDeps {
  downloadFile: (url: string, forzarRefresco: boolean) => Promise<DownloadedFile>;
  listFolderFiles: (url: string) => Promise<Array<{ name: string; url: string }>>;
}

export interface MaterialsOptions {
  items: MaterialItem[];
  destino: string; // ruta absoluta ya resuelta
  query?: string;
  maxArchivos: number;
  forzarRefresco: boolean;
  concurrencia?: number;
  onProgress?: (hechos: number, total: number, mensaje: string) => void | Promise<void>;
}

export interface MaterialsResult {
  carpeta: string;
  descargados: string[];
  salteados: string[];
  fallidos: Array<{ nombre: string; motivo: string }>;
  ignorados: number;
  omitidosPorLimite: number;
  bytes: number;
}

export const normalizeText = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Nombre de archivo/carpeta seguro para Windows, macOS y Linux
export function sanitizeFilename(name: string, maxLen = 120): string {
  let s = (name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim().replace(/[. ]+$/, "");
  if (!s) s = "archivo";
  if (RESERVED.test(s.split(".")[0])) s = "_" + s;
  return s;
}

// Expande "~" y exige ruta absoluta
export function resolveDestino(input: string | undefined, fallbackName: string): string {
  if (!input || !input.trim()) {
    return path.join(os.homedir(), "Downloads", "UCA", sanitizeFilename(fallbackName, 80));
  }
  let p = input.trim();
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    throw new Error("'carpeta_destino' debe ser una ruta absoluta (o empezar con '~'). Ejemplo: ~/Documents/Parciales");
  }
  return path.resolve(p);
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "text/plain": ".txt"
};

function realExtension(file: DownloadedFile): string {
  const ext = path.extname(file.filename || "").toLowerCase();
  if (/^\.[a-z0-9]{1,6}$/.test(ext)) return ext;
  const mime = (file.mimeType || "").split(";")[0].trim().toLowerCase();
  return MIME_EXT[mime] ?? "";
}

// Reserva un nombre único (sin distinguir mayúsculas) agregando " (2)", " (3)"...
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${name} (${n++})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function splitExt(name: string): { base: string; ext: string } {
  const ext = path.extname(name);
  if (ext && /^\.[A-Za-z0-9]{1,6}$/.test(ext)) return { base: name.slice(0, -ext.length), ext };
  return { base: name, ext: "" };
}

interface Task {
  display: string;
  dir: string; // subcarpeta relativa ("" = raíz)
  url: string;
  baseName?: string; // recurso suelto: nombre sin extensión (la extensión sale del archivo real)
  fixedName?: string; // archivo dentro de carpeta: nombre final ya definido
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

export async function descargarMateriales(opts: MaterialsOptions, deps: MaterialsDeps): Promise<MaterialsResult> {
  const destRoot = path.resolve(opts.destino);
  const concurrencia = opts.concurrencia ?? 6;
  const result: MaterialsResult = {
    carpeta: destRoot,
    descargados: [],
    salteados: [],
    fallidos: [],
    ignorados: 0,
    omitidosPorLimite: 0,
    bytes: 0
  };

  const q = opts.query ? normalizeText(opts.query) : "";
  const rootNames = new Set<string>();
  const folderNames = new Map<string, Set<string>>();
  const tasks: Task[] = [];

  const candidatos: MaterialItem[] = [];
  for (const it of opts.items) {
    if ((it.tipo === "resource" || it.tipo === "folder") && it.url) candidatos.push(it);
    else result.ignorados++;
  }

  // Expandir carpetas (en paralelo) y armar la lista plana de archivos con nombres deterministas
  const expansiones = new Map<MaterialItem, Array<{ name: string; url: string }> | Error>();
  await pool(candidatos.filter((c) => c.tipo === "folder"), concurrencia, async (c) => {
    try {
      expansiones.set(c, await deps.listFolderFiles(c.url!));
    } catch (err) {
      expansiones.set(c, err instanceof Error ? err : new Error(String(err)));
    }
  });

  for (const it of candidatos) {
    if (it.tipo === "resource") {
      tasks.push({
        display: it.nombre,
        dir: "",
        url: it.url!,
        baseName: uniqueName(sanitizeFilename(it.nombre), rootNames)
      });
      continue;
    }
    const exp = expansiones.get(it);
    if (!exp || exp instanceof Error) {
      result.fallidos.push({ nombre: it.nombre, motivo: `No se pudo listar la carpeta: ${exp instanceof Error ? exp.message : "error desconocido"}` });
      continue;
    }
    const matching = it.coincide === false && q ? exp.filter((f) => normalizeText(f.name).includes(q)) : exp;
    if (matching.length === 0) continue;
    const dir = uniqueName(sanitizeFilename(it.nombre), rootNames);
    const used = new Set<string>();
    folderNames.set(dir, used);
    for (const f of matching) {
      const { base, ext } = splitExt(sanitizeFilename(f.name, 150));
      const unique = uniqueName(base, used);
      tasks.push({ display: `${it.nombre}/${f.name}`, dir, url: f.url, fixedName: unique + ext });
    }
  }

  if (tasks.length > opts.maxArchivos) {
    result.omitidosPorLimite = tasks.length - opts.maxArchivos;
    tasks.length = opts.maxArchivos;
  }

  const total = tasks.length;
  let hechos = 0;
  await pool(tasks, concurrencia, async (task) => {
    try {
      const file = await deps.downloadFile(task.url, opts.forzarRefresco);
      let finalName: string;
      if (task.fixedName) {
        finalName = task.fixedName;
      } else {
        const ext = realExtension(file);
        const base = task.baseName!;
        finalName = ext && base.toLowerCase().endsWith(ext) ? base : base + ext;
      }
      const dirFull = path.resolve(destRoot, task.dir);
      const full = path.resolve(dirFull, finalName);
      if (!(dirFull === destRoot || dirFull.startsWith(destRoot + path.sep)) || !full.startsWith(destRoot + path.sep)) {
        throw new Error("Ruta fuera de la carpeta de destino (bloqueada).");
      }
      const shown = task.dir ? `${task.dir}/${finalName}` : finalName;
      let existing = -1;
      try { existing = fs.statSync(full).size; } catch {}
      if (existing === file.buffer.length) {
        result.salteados.push(shown);
      } else {
        await fs.promises.mkdir(dirFull, { recursive: true });
        await fs.promises.writeFile(full, file.buffer);
        result.descargados.push(shown);
        result.bytes += file.buffer.length;
      }
    } catch (err) {
      result.fallidos.push({ nombre: task.display, motivo: err instanceof Error ? err.message : String(err) });
    } finally {
      hechos++;
      try { await opts.onProgress?.(hechos, total, `Archivos procesados: ${hechos}/${total}`); } catch {}
    }
  });

  result.descargados.sort();
  result.salteados.sort();
  return result;
}
