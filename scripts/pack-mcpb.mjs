import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
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

// 1. Archivos raíz esenciales
const rootFiles = ["manifest.json", "package.json", "README.md", "LICENSE", "tsconfig.json"];
for (const file of rootFiles) {
  const filePath = path.join(ROOT_DIR, file);
  if (fs.existsSync(filePath)) {
    zipEntries[file] = fs.readFileSync(filePath);
    console.log(`  + ${file}`);
  }
}

// 2. Archivos compilados en build/ y código fuente auditable
function addDirRecursive(dir, prefix = "") {
  if (!fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    // Excluir archivos y carpetas de test del paquete de distribución
    if (prefix === "build" && item.name === "test") continue;

    const fullPath = path.join(dir, item.name);
    const relPath = path.join(prefix, item.name).replace(/\\/g, "/");
    if (item.isDirectory()) {
      addDirRecursive(fullPath, relPath);
    } else {
      zipEntries[relPath] = fs.readFileSync(fullPath);
      console.log(`  + ${relPath}`);
    }
  }
}

addDirRecursive(BUILD_DIR, "build");
addDirRecursive(path.join(ROOT_DIR, "vendor"), "vendor");
addDirRecursive(path.join(ROOT_DIR, "src"), "src");
addDirRecursive(path.join(ROOT_DIR, "scripts"), "scripts");
addDirRecursive(path.join(ROOT_DIR, "bin"), "bin");

// 3. Dependencias de producción en node_modules
console.log("[PACK] Empaquetando dependencias de producción (node_modules)...");
try {
  const prodOutput = execSync("npm ls --omit=dev --parseable --all", { encoding: "utf8" });
  const prodDirs = prodOutput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(1);
  const addedDirs = new Set();

  for (const pkgDir of prodDirs) {
    if (!fs.existsSync(pkgDir) || addedDirs.has(pkgDir)) continue;
    addedDirs.add(pkgDir);

    function scanPkg(dir) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          if (item.name === "test" || item.name === "tests" || item.name === ".github" || item.name === ".bin") continue;
          scanPkg(path.join(dir, item.name));
        } else {
          if (item.name.endsWith(".map") || item.name.endsWith(".tsbuildinfo")) continue;
          const full = path.join(dir, item.name);
          const rel = path.relative(ROOT_DIR, full).replace(/\\/g, "/");
          zipEntries[rel] = fs.readFileSync(full);
        }
      }
    }
    scanPkg(pkgDir);
  }
} catch (err) {
  console.warn(`[WARN] No se pudieron listar dependencias con npm ls: ${err.message}`);
}

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
