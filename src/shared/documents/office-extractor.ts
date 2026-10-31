import * as fflate from "fflate";
import * as cheerio from "cheerio";

const MAX_UNCOMPRESSED_SIZE = 60 * 1024 * 1024; // 60 MB límite anti-zip-bomb

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024; // 2 MB de texto de salida

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Texto truncado: el documento supera los 2 MB de texto]";
}

function unzipFiltered(buffer: Uint8Array, pattern: RegExp): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  let totalExtractedBytes = 0;

  // Descompresor en streaming que aborta en tiempo real antes de inflar gigabytes en memoria
  class BoundedUnzipInflate {
    static compression = 8;
    i: fflate.Inflate;
    ondata!: (err: Error | null, dat: Uint8Array, final: boolean) => void;

    constructor() {
      this.i = new fflate.Inflate((dat, final) => {
        totalExtractedBytes += dat.length;
        if (totalExtractedBytes > MAX_UNCOMPRESSED_SIZE) {
          throw new Error("El archivo excede el límite máximo de descompresión de seguridad (60 MB).");
        }
        this.ondata(null, dat, final);
      });
    }

    push(chunk: Uint8Array, final: boolean) {
      this.i.push(chunk, final);
    }
  }

  const unzipper = new fflate.Unzip();
  unzipper.register(BoundedUnzipInflate as any);
  unzipper.register(fflate.UnzipPassThrough);

  unzipper.onfile = (file) => {
    if (!pattern.test(file.name)) {
      return;
    }
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      if (chunk) chunks.push(chunk);
      if (final) {
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.length;
        }
        result[file.name] = combined;
      }
    };
    file.start();
  };

  unzipper.push(buffer, true);
  return result;
}

export function extractDocxText(buffer: Uint8Array): string {
  const files = unzipFiltered(buffer, /^word\/document\.xml$/);
  const docFile = files["word/document.xml"];
  if (!docFile) {
    throw new Error("Estructura de documento .docx inválida (falta word/document.xml).");
  }

  const xml = fflate.strFromU8(docFile);
  const $ = cheerio.load(xml, { xmlMode: true });

  const parts: string[] = [];
  let prevTc: any = null;
  let prevTr: any = null;
  let size = 0;
  $("w\\:p").each((_, p) => {
    if (size > MAX_OUTPUT_CHARS) return false;
    let text = "";
    $(p).find("w\\:t, w\\:tab, w\\:br").each((__, el) => {
      const name = (el as any).name;
      if (name === "w:t") text += $(el).text();
      else if (name === "w:tab") text += "\t";
      else if (name === "w:br") text += "\n";
    });
    if (text.trim().length === 0) return;
    const tc = $(p).closest("w\\:tc")[0] ?? null;
    const tr = tc ? $(tc).closest("w\\:tr")[0] ?? null : null;
    const sep = parts.length === 0 ? "" : tc && prevTc && tc !== prevTc && tr === prevTr ? "\t" : "\n\n";
    parts.push(sep + text);
    size += sep.length + text.length;
    prevTc = tc;
    prevTr = tr;
  });

  return capOutput(parts.join(""));
}

export function extractPptxText(buffer: Uint8Array): string {
  const files = unzipFiltered(buffer, /^ppt\/slides\/slide\d+\.xml$/);
  const slideKeys = Object.keys(files)
    .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });

  if (slideKeys.length === 0) {
    throw new Error("No se encontraron diapositivas en la presentación .pptx.");
  }

  const output: string[] = [];
  for (let i = 0; i < slideKeys.length; i++) {
    if (output.join("").length > MAX_OUTPUT_CHARS) break;
    const key = slideKeys[i];
    const slideNum = parseInt(/slide(\d+)\.xml$/.exec(key)?.[1] ?? "", 10) || i + 1;
    const xml = fflate.strFromU8(files[key]);
    delete files[key];
    const $ = cheerio.load(xml, { xmlMode: true });
    const texts = $("a\\:t").map((_, el) => $(el).text()).get();

    if (texts.length > 0) {
      output.push(`--- Diapositiva ${slideNum} ---\n${texts.join(" ")}`);
    }
  }

  return output.join("\n\n");
}

// Convierte letras de columna de Excel (A, B, ..., Z, AA, AB) a índice 0-based
function colLetterToIndex(colStr: string): number {
  let idx = 0;
  for (let i = 0; i < colStr.length; i++) {
    idx = idx * 26 + (colStr.charCodeAt(i) - 64);
  }
  return idx - 1;
}

export function extractXlsxText(buffer: Uint8Array): string {
  const files = unzipFiltered(buffer, /^(xl\/sharedStrings\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet\d+\.xml)$/);

  // 1. Parsear cadenas compartidas (sharedStrings.xml)
  const sharedStrings: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const sstXml = fflate.strFromU8(files["xl/sharedStrings.xml"]);
    const $sst = cheerio.load(sstXml, { xmlMode: true });
    $sst("si").each((_, si) => {
      const text = $sst(si).find("t").filter((_, t) => (t as any).parent?.name !== "rPh").map((_, t) => $sst(t).text()).get().join("");
      sharedStrings.push(text);
    });
  }

  // 2. Parsear hojas de cálculo (worksheets/sheet*.xml)
  const sheetKeys = Object.keys(files)
    .filter((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml"))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });

  // Nombres reales de hoja desde workbook.xml (+ rels para mapear al archivo)
  const sheetNames: Record<string, string> = {};
  try {
    if (files["xl/workbook.xml"]) {
      const rels: Record<string, string> = {};
      if (files["xl/_rels/workbook.xml.rels"]) {
        const $r = cheerio.load(fflate.strFromU8(files["xl/_rels/workbook.xml.rels"]), { xmlMode: true });
        $r("Relationship").each((_, el) => {
          const id = $r(el).attr("Id");
          const target = $r(el).attr("Target");
          if (id && target) rels[id] = "xl/" + target.replace(/^\/?(xl\/)?/, "");
        });
      }
      const $w = cheerio.load(fflate.strFromU8(files["xl/workbook.xml"]), { xmlMode: true });
      $w("sheet").each((idx, el) => {
        const name = $w(el).attr("name");
        const rid = $w(el).attr("r:id");
        const file = (rid && rels[rid]) || `xl/worksheets/sheet${idx + 1}.xml`;
        if (name) sheetNames[file] = name;
      });
    }
  } catch {}

  const output: string[] = [];
  let outSize = 0;
  for (let s = 0; s < sheetKeys.length; s++) {
    if (outSize > MAX_OUTPUT_CHARS) break;
    const sheetXml = fflate.strFromU8(files[sheetKeys[s]]);
    delete files[sheetKeys[s]];
    const $sheet = cheerio.load(sheetXml, { xmlMode: true });
    const sheetRows: string[] = [];

    $sheet("row").each((_, row) => {
      const cells: string[] = [];
      let currentCol = 0;

      $sheet(row).find("c").each((_, cell) => {
        const r = $sheet(cell).attr("r") || "";
        const colMatch = /^([A-Z]+)/i.exec(r);
        if (colMatch) {
          const targetCol = colLetterToIndex(colMatch[1].toUpperCase());
          if (targetCol >= currentCol) {
            // Limitar relleno de celdas vacías a 100 columnas para evitar saturación de memoria en coordenadas lejanas
            const maxFillCol = Math.min(targetCol, currentCol + 100);
            while (currentCol < maxFillCol) {
              cells.push("");
              currentCol++;
            }
            currentCol = targetCol;
          }
        }

        const type = $sheet(cell).attr("t");
        const v = $sheet(cell).find("v").text().trim();
        let val = v;

        if (type === "s") {
          const idx = parseInt(v, 10);
          val = sharedStrings[idx] ?? v;
        } else if (type === "inlineStr") {
          val = $sheet(cell).find("is t").filter((_, t) => (t as any).parent?.name !== "rPh").text();
        } else if (type === "b") {
          val = v === "1" ? "VERDADERO" : "FALSO";
        } else if (type === "str") {
          val = v;
        } else if (type === "e") {
          val = v || "#ERROR";
        }

        cells.push(val);
        currentCol++;
      });

      if (cells.some((c) => c.trim().length > 0)) {
        sheetRows.push(cells.join(" | "));
      }
    });

    if (sheetRows.length > 0) {
      output.push(`=== Hoja ${s + 1} ===\n${sheetRows.join("\n")}`);
    }
  }

  return output.join("\n\n");
}

// Extrae texto de documentos OpenDocument (.odt, .ods, .odp) mediante content.xml
export function extractOdfText(buffer: Uint8Array): string {
  const files = unzipFiltered(buffer, /^content\.xml$/);
  const docFile = files["content.xml"];
  if (!docFile) {
    throw new Error("Estructura de documento OpenDocument inválida (falta content.xml).");
  }

  const xml = fflate.strFromU8(docFile);
  const $ = cheerio.load(xml, { xmlMode: true });
  const lines: string[] = [];

  $("text\\:p, text\\:h, table\\:table-row").each((_, el) => {
    if (el.name === "table:table-row") {
      const rowCells: string[] = [];
      $(el).find("table\\:table-cell").each((__, cell) => {
        const text = $(cell).text().trim();
        if (text) rowCells.push(text);
      });
      if (rowCells.length > 0) lines.push(rowCells.join(" | "));
    } else {
      if ($(el).parents("table\\:table-row").length > 0) return;
      const text = $(el).text().trim();
      if (text) lines.push(text);
    }
  });

  return lines.join("\n\n");
}

// Valida magic bytes para determinar el mimeType real de imágenes
export function detectImageMimeType(buffer: Uint8Array): string | null {
  if (buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // GIF: GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  // WebP: RIFF .... WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "image/webp";

  return null;
}
