// Empaqueta build/src/index.js (salida de tsc) en un único archivo ESM para acelerar el arranque:
// evita resolver y leer cientos de módulos pequeños de node_modules (MCP SDK, zod, cheerio, etc.).
// playwright-core y pdfjs-dist se mantienen externos porque se cargan de forma perezosa (solo login / PDFs).
import fs from "node:fs";
import path from "node:path";

const entry = path.join(process.cwd(), "build", "src", "index.js");

if (!fs.existsSync(entry)) {
  console.error("[BUNDLE] No existe build/src/index.js. Ejecutá 'tsc' primero.");
  process.exit(1);
}

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.warn("[BUNDLE] esbuild no está instalado: se omite el empaquetado (el servidor funciona igual, con arranque más lento).");
  process.exit(0);
}

const tmpOut = `${entry}.bundle.tmp.mjs`;
await esbuild.build({
  entryPoints: [entry],
  outfile: tmpOut,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["playwright-core", "pdfjs-dist", "pdfjs-dist/*"],
  banner: {
    js: "import { createRequire as __ucaCreateRequire } from 'node:module'; const require = __ucaCreateRequire(import.meta.url);"
  },
  legalComments: "none",
  logLevel: "warning"
});
fs.renameSync(tmpOut, entry);
console.log(`[BUNDLE] ${path.relative(process.cwd(), entry)} empaquetado (${(fs.statSync(entry).size / 1024).toFixed(0)} KB)`);
