import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { encodeRawToPng } from "./png-encoder.js";

// Polyfill Promise.withResolvers para Node <22 (ej. Node 20.18.1 requerido por Cheerio)
if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const require = createRequire(import.meta.url);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Resuelve la carpeta vendor ascendiendo desde el archivo actual
function findVendorDir(): string {
  // Sube desde el directorio actual hasta hallar vendor/pdfjs (funciona en src/, build/ y en el bundle único)
  let dir = currentDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "vendor", "pdfjs");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(currentDir, "../../../../vendor/pdfjs");
}

const vendorDir = findVendorDir();
const vendorPdfPath = path.join(vendorDir, "pdf.mjs");
const vendorCmaps = path.join(vendorDir, "cmaps") + path.sep;
const vendorFonts = path.join(vendorDir, "standard_fonts") + path.sep;

// Importación perezosa de pdfjs: usa vendor/pdfjs/pdf.mjs para no descargar @napi-rs/canvas (37MB)
let pdfjsLibCache: any = null;
async function getPdfJs() {
  if (!pdfjsLibCache) {
    if (fs.existsSync(vendorPdfPath)) {
      pdfjsLibCache = await import(pathToFileURL(vendorPdfPath).href);
    } else {
      pdfjsLibCache = await import("pdfjs-dist/legacy/build/pdf.mjs");
    }
  }
  return pdfjsLibCache;
}

// Resolver cmaps y fuentes estándar desde vendor/ o node_modules
let cMapUrl: string | undefined;
let standardFontDataUrl: string | undefined;

if (fs.existsSync(vendorCmaps)) {
  cMapUrl = vendorCmaps;
  standardFontDataUrl = vendorFonts;
} else {
  try {
    const pdfjsPkgPath = require.resolve("pdfjs-dist/package.json");
    const pdfjsDir = path.dirname(pdfjsPkgPath);
    cMapUrl = path.join(pdfjsDir, "cmaps") + path.sep;
    standardFontDataUrl = path.join(pdfjsDir, "standard_fonts") + path.sep;
  } catch {
    try {
      cMapUrl = fileURLToPath(import.meta.resolve("pdfjs-dist/cmaps/"));
      standardFontDataUrl = fileURLToPath(import.meta.resolve("pdfjs-dist/standard_fonts/"));
    } catch {}
  }
}

export interface ExtractedBlock {
  type: "text" | "image";
  text?: string;
  data?: string; // Base64 para imágenes
  mimeType?: string;
}

// Desempaqueta 1 bit por píxel a escala de grises de 8 bits (0 o 255)
function unpack1BitTo8Bit(src: Uint8Array, width: number, height: number): Uint8Array {
  const dst = new Uint8Array(width * height);
  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = y * rowBytes + (x >> 3);
      const bitIdx = 7 - (x & 7);
      const bit = (src[byteIdx] >> bitIdx) & 1;
      dst[y * width + x] = bit ? 255 : 0;
    }
  }
  return dst;
}

// Redimensiona mapas de bits que excedan los 1500 píxeles por lado para no saturar el contexto
function downsampleImage(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  maxSide = 1500
): { data: Uint8Array; width: number; height: number } {
  if (width <= maxSide && height <= maxSide) return { data, width, height };
  const scale = maxSide / Math.max(width, height);
  const newWidth = Math.max(1, Math.floor(width * scale));
  const newHeight = Math.max(1, Math.floor(height * scale));
  const dst = new Uint8Array(newWidth * newHeight * channels);

  for (let y = 0; y < newHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const srcOffset = (srcY * width + srcX) * channels;
      const dstOffset = (y * newWidth + x) * channels;
      for (let c = 0; c < channels; c++) {
        dst[dstOffset + c] = data[srcOffset + c];
      }
    }
  }
  return { data: dst, width: newWidth, height: newHeight };
}

export interface PdfExtractResult {
  blocks: ExtractedBlock[];
  totalPaginas: number;
  proximaPagina?: number;
}

export async function extractPdfContent(
  buffer: Uint8Array,
  desdePagina = 1,
  maxPages = 15
): Promise<PdfExtractResult> {
  const pdfjsLib = await getPdfJs();
  const loadingTask = pdfjsLib.getDocument({
    data: buffer.slice(),
    isEvalSupported: false,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl
  });

  const doc = await loadingTask.promise;
  const blocks: ExtractedBlock[] = [];
  const MAX_IMAGES_TOTAL = 10;
  let totalImagesExtracted = 0;
  let endPage = 0;

  try {
    const startPage = Math.max(1, desdePagina);
    endPage = Math.min(doc.numPages, startPage + maxPages - 1);
    const MAX_AGGREGATE_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB tope agregado para imágenes extraídas en base64
    let aggregateImageBytes = 0;

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items as Array<{ str?: string; hasEOL?: boolean }>)
        .map((item) => (item.str || "") + (item.hasEOL ? "\n" : " "))
        .join("")
        .replace(/[^\S\n]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (pageText.length > 0) {
        blocks.push({
          type: "text",
          text: `--- Página ${pageNum} de ${doc.numPages} ---\n${pageText}`
        });
      }

      if (pageText.length <= 30) {
        // Posible página escaneada o con figuras: extraer imágenes de la página
        const ops = await page.getOperatorList();
        let foundImage = false;

        for (let i = 0; i < ops.fnArray.length; i++) {
          if (totalImagesExtracted >= MAX_IMAGES_TOTAL) break;

          if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject) {
            const imgName = ops.argsArray[i][0];
            try {
              // Obtener objeto de forma asíncrona segura con timeout de 5s para evitar cuelgues
              const imgObj = await new Promise<any>((resolve) => {
                const timer = setTimeout(() => resolve(null), 5000);
                try {
                  let direct: any;
                  if (typeof (page.objs as any).has === "function" && (page.objs as any).has(imgName)) {
                    direct = (page.objs as any).get(imgName);
                  }
                  if (direct) {
                    clearTimeout(timer);
                    resolve(direct);
                    return;
                  }
                  (page.objs as any).get(imgName, (res: any) => {
                    clearTimeout(timer);
                    resolve(res);
                  });
                } catch {
                  clearTimeout(timer);
                  resolve(null);
                }
              });

              if (imgObj && imgObj.data && imgObj.width && imgObj.height) {
                // 1. Passthrough directo si los bytes crudos ya corresponden a JPEG estándar
                if (
                  imgObj.data.length > 3 &&
                  imgObj.data[0] === 0xff &&
                  imgObj.data[1] === 0xd8 &&
                  imgObj.data[2] === 0xff
                ) {
                  const imgBytes = imgObj.data.length;
                  if (imgBytes <= 5 * 1024 * 1024 && aggregateImageBytes + imgBytes <= MAX_AGGREGATE_IMAGE_BYTES) {
                    blocks.push({
                      type: "image",
                      data: Buffer.from(imgObj.data).toString("base64"),
                      mimeType: "image/jpeg"
                    });
                    aggregateImageBytes += imgBytes;
                    foundImage = true;
                    totalImagesExtracted++;
                  } else if (aggregateImageBytes + imgBytes > MAX_AGGREGATE_IMAGE_BYTES) {
                    blocks.push({
                      type: "text",
                      text: `--- Página ${pageNum} de ${doc.numPages} ---\n[Imagen omitida: se alcanzó el tope máximo agregado de imágenes (${Math.round(MAX_AGGREGATE_IMAGE_BYTES / (1024 * 1024))} MB)]`
                    });
                    foundImage = true;
                  }
                  continue;
                }

                // 2. Determinar canales y corregir 1-bit empaquetado si aplica
                let rawPixels: Uint8Array = imgObj.data;
                const channels: 1 | 3 | 4 = imgObj.kind === 1 ? 1 : imgObj.kind === 2 ? 3 : 4;

                if (channels === 1 && rawPixels.length < imgObj.width * imgObj.height) {
                  rawPixels = unpack1BitTo8Bit(rawPixels, imgObj.width, imgObj.height);
                }

                // 3. Redimensionar si supera 1500px por lado
                const down = downsampleImage(rawPixels, imgObj.width, imgObj.height, channels, 1500);

                const pngBuf = encodeRawToPng(down.width, down.height, down.data, channels);
                if (aggregateImageBytes + pngBuf.length <= MAX_AGGREGATE_IMAGE_BYTES) {
                  blocks.push({
                    type: "image",
                    data: pngBuf.toString("base64"),
                    mimeType: "image/png"
                  });
                  aggregateImageBytes += pngBuf.length;
                  foundImage = true;
                  totalImagesExtracted++;
                } else {
                  blocks.push({
                    type: "text",
                    text: `--- Página ${pageNum} de ${doc.numPages} ---\n[Imagen omitida: se alcanzó el tope máximo agregado de imágenes (${Math.round(MAX_AGGREGATE_IMAGE_BYTES / (1024 * 1024))} MB)]`
                  });
                  foundImage = true;
                }
              }
            } catch {
              // Ignorar fallo al decodificar imagen individual
            }
          }
        }

        if (!foundImage && pageText.length === 0) {
          blocks.push({
            type: "text",
            text: `--- Página ${pageNum} de ${doc.numPages} ---\n[Página escaneada o sin texto digitalizable]`
          });
        }
      }
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      // Ignorar error al destruir el documento
    }
  }

  return {
    blocks,
    totalPaginas: doc.numPages,
    proximaPagina: endPage < doc.numPages ? endPage + 1 : undefined
  };
}
