import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as fflate from "fflate";

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, "dist");
const BUILD_DIR = path.join(ROOT_DIR, "build");

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf8"));
const bundleName = `${manifest.name}-${manifest.version}.mcpb`;
const bundlePath = path.join(DIST_DIR, bundleName);

console.log(`[PACK] Empaquetando bundle MCPB: ${bundleName}...`);

const zipEntries = {};

// 1. Archivos raíz esenciales (package.json mínimo: "type":"module" es necesario para ejecutar el bundle ESM)
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
const bundleEntry = path.join(BUILD_DIR, "src", "index.js");
if (!fs.existsSync(bundleEntry)) {
  console.error("[PACK] Falta build/src/index.js. Ejecutá 'npm run build' primero.");
  process.exit(1);
}
const isBundled = !/from\s+["']\.\.?\//.test(fs.readFileSync(bundleEntry, "utf8"));
if (!isBundled) {
  console.error("[PACK] build/src/index.js no está empaquetado con esbuild (tiene imports relativos). Ejecutá 'npm run build'.");
  process.exit(1);
}
zipEntries["package.json"] = Buffer.from(JSON.stringify({
  name: rootPkg.name,
  version: rootPkg.version,
  type: "module",
  license: rootPkg.license,
  dependencies: { "playwright-core": rootPkg.dependencies["playwright-core"] }
}, null, 2) + "\n");
for (const file of ["manifest.json", "README.md", "LICENSE"]) {
  const filePath = path.join(ROOT_DIR, file);
  if (fs.existsSync(filePath)) zipEntries[file] = fs.readFileSync(filePath);
}

// 2. Solo el bundle único y pdfjs vendorizado (el resto de build/, src/, scripts/ no se necesita en runtime)
function addDirRecursive(dir, prefix = "", skip = () => false) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    const relPath = path.posix.join(prefix, item.name);
    if (skip(relPath, item)) continue;
    if (item.isDirectory()) addDirRecursive(fullPath, relPath, skip);
    else zipEntries[relPath] = fs.readFileSync(fullPath);
  }
}
zipEntries["build/src/index.js"] = fs.readFileSync(bundleEntry);
addDirRecursive(path.join(ROOT_DIR, "vendor"), "vendor");

// 3. node_modules mínimo: solo playwright-core (sin dependencias propias), sin tipos ni documentación
addDirRecursive(path.join(ROOT_DIR, "node_modules", "playwright-core"), "node_modules/playwright-core", (rel, item) =>
  item.isDirectory()
    ? item.name === "types" || item.name === "test" || item.name === "tests"
    : /\.(map|md|d\.ts)$/.test(item.name) || item.name === "ThirdPartyNotices.txt"
);
console.log(`[PACK] ${Object.keys(zipEntries).length} archivos`);

// 4. Comprimir a formato .mcpb (ZIP estándar) con compresión nivel 6 balanceada
const zipped = fflate.zipSync(zipEntries, { level: 6 });
fs.writeFileSync(bundlePath, zipped);

// 4. Calcular hash SHA256 y firma digital
const hash = crypto.createHash("sha256").update(zipped).digest("hex");
const checksumPath = `${bundlePath}.sha256`;
fs.writeFileSync(checksumPath, `${hash}  ${bundleName}\n`);

if (process.env.MCPB_PRIVATE_KEY) {
  try {
    const sign = crypto.createSign("SHA256");
    sign.update(zipped);
    sign.end();
    const signature = sign.sign(process.env.MCPB_PRIVATE_KEY, "hex");
    fs.writeFileSync(`${bundlePath}.sig`, signature);
    console.log(` Firma criptográfica generada en: ${bundleName}.sig`);
  } catch (err) {
    console.warn(`[WARN] No se pudo firmar el bundle con MCPB_PRIVATE_KEY: ${err.message}`);
  }
}

console.log("==================================================");
console.log(` Paquete .mcpb generado con éxito en:`);
console.log(` -> ${bundlePath} (${(zipped.length / 1024).toFixed(1)} KB)`);
console.log(` SHA256: ${hash}`);
console.log("==================================================");
