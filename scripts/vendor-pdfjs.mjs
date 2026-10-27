import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const vendorDir = path.join(rootDir, "vendor", "pdfjs");
const pdfjsDistDir = path.join(rootDir, "node_modules", "pdfjs-dist");

if (!fs.existsSync(pdfjsDistDir)) {
  console.log("[VENDOR] pdfjs-dist no encontrado en node_modules. Omitiendo vendor.");
  process.exit(0);
}

fs.mkdirSync(vendorDir, { recursive: true });

// 1. Copiar pdf.mjs y pdf.worker.mjs de legacy/build (sin requerir canvas ni dependencias nativas de 37MB)
const srcPdfMjs = path.join(pdfjsDistDir, "legacy", "build", "pdf.mjs");
const dstPdfMjs = path.join(vendorDir, "pdf.mjs");
fs.copyFileSync(srcPdfMjs, dstPdfMjs);

const srcWorkerMjs = path.join(pdfjsDistDir, "legacy", "build", "pdf.worker.mjs");
const dstWorkerMjs = path.join(vendorDir, "pdf.worker.mjs");
fs.copyFileSync(srcWorkerMjs, dstWorkerMjs);

// 2. Copiar cmaps/ para soporte de fuentes
const srcCmaps = path.join(pdfjsDistDir, "cmaps");
const dstCmaps = path.join(vendorDir, "cmaps");
fs.cpSync(srcCmaps, dstCmaps, { recursive: true });

// 3. Copiar standard_fonts/
const srcFonts = path.join(pdfjsDistDir, "standard_fonts");
const dstFonts = path.join(vendorDir, "standard_fonts");
fs.cpSync(srcFonts, dstFonts, { recursive: true });

console.log("[VENDOR] pdf.js y fuentes copiadas con éxito a vendor/pdfjs/");
