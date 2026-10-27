import * as fflate from "fflate";
import * as cheerio from "cheerio";

const MAX_UNCOMPRESSED_SIZE = 60 * 1024 * 1024; // 60 MB límite anti-zip-bomb

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

  const paragraphs: string[] = [];
  $("w\\:p").each((_, p) => {
    const text = $(p).find("w\\:t").map((_, t) => $(t).text()).get().join("");
    if (text.trim().length > 0) {
      paragraphs.push(text);
    }
  });

  return paragraphs.join("\n\n");
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
    const key = slideKeys[i];
    const xml = fflate.strFromU8(files[key]);
    const $ = cheerio.load(xml, { xmlMode: true });
    const texts = $("a\\:t").map((_, el) => $(el).text()).get();

    if (texts.length > 0) {
      output.push(`--- Diapositiva ${i + 1} ---\n${texts.join(" ")}`);
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
  const files = unzipFiltered(buffer, /^(xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml)$/);

  // 1. Parsear cadenas compartidas (sharedStrings.xml)
  const sharedStrings: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const sstXml = fflate.strFromU8(files["xl/sharedStrings.xml"]);
    const $sst = cheerio.load(sstXml, { xmlMode: true });
    $sst("si").each((_, si) => {
      const text = $sst(si).find("t").map((_, t) => $sst(t).text()).get().join("");
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

  const output: string[] = [];
  for (let s = 0; s < sheetKeys.length; s++) {
    const sheetXml = fflate.strFromU8(files[sheetKeys[s]]);
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
          val = $sheet(cell).find("is t").text();
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
