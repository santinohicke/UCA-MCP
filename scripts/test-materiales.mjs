// Pruebas de la descarga de materiales a disco con servicios simulados (sin red).
// Uso: node scripts/test-materiales.mjs  (requiere haber compilado: npm run build)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { descargarMateriales, sanitizeFilename, resolveDestino } from "../build/src/shared/documents/materials-downloader.js";

const buf = (s) => new Uint8Array(Buffer.from(s));
const pdf = (s, filename = "x.pdf") => ({ buffer: buf(s), mimeType: "application/pdf", filename });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uca-mat-"));
let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

try {
  // Saneo de nombres
  assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), "a b c d e f g h i j");
  assert.equal(sanitizeFilename("CON"), "_CON");
  assert.equal(sanitizeFilename("nul.txt"), "_nul.txt");
  assert.equal(sanitizeFilename("...  "), "archivo");
  assert.equal(sanitizeFilename("x".repeat(300)).length, 120);
  assert.equal(sanitizeFilename("../../etc/passwd"), "etc passwd");
  assert.ok(path.isAbsolute(resolveDestino("~/Parciales", "x")));
  assert.throws(() => resolveDestino("relativa/ruta", "x"));
  ok("saneo y resolución de destino");

  // Expansión de carpetas, duplicados, extensión real, ignorados y límite
  const dest = path.join(tmp, "fisica");
  const folderFiles = [
    { name: "Parcial 2008.pdf", url: "https://eva/pluginfile.php/1/a.pdf" },
    { name: "Parcial 2008.pdf", url: "https://eva/pluginfile.php/1/b.pdf" },
    { name: "Resumen.docx", url: "https://eva/pluginfile.php/1/c.docx" }
  ];
  const deps = {
    downloadFile: async (url) => {
      if (url.includes("boom")) throw new Error("HTTP 500");
      return pdf(url, url.endsWith(".docx") ? "c.docx" : "servidor.pdf");
    },
    listFolderFiles: async (url) => {
      if (url.includes("rota")) throw new Error("sin acceso");
      return folderFiles;
    }
  };
  const items = [
    { nombre: "Primer parcial 2007", tipo: "resource", url: "https://eva/mod/resource/view.php?id=1" },
    { nombre: "Primer parcial 2007", tipo: "resource", url: "https://eva/mod/resource/view.php?id=2" },
    { nombre: "../../Escape", tipo: "resource", url: "https://eva/mod/resource/view.php?id=3" },
    { nombre: "Falla", tipo: "resource", url: "https://eva/boom" },
    { nombre: "Parciales anteriores", tipo: "folder", url: "https://eva/mod/folder/view.php?id=9" },
    { nombre: "Carpeta rota", tipo: "folder", url: "https://eva/mod/folder/view.php?id=rota" },
    { nombre: "Parciales", tipo: "page", url: "https://eva/mod/page/view.php?id=5" },
    { nombre: "Foro", tipo: "forum", url: "https://eva/mod/forum/view.php?id=6" }
  ];
  const r1 = await descargarMateriales({ items, destino: dest, maxArchivos: 300, forzarRefresco: false }, deps);
  assert.equal(r1.ignorados, 2);
  assert.equal(r1.fallidos.length, 2);
  assert.deepEqual(
    fs.readdirSync(dest).sort(),
    ["Escape.pdf", "Parciales anteriores", "Primer parcial 2007 (2).pdf", "Primer parcial 2007.pdf"]
  );
  assert.deepEqual(
    fs.readdirSync(path.join(dest, "Parciales anteriores")).sort(),
    ["Parcial 2008 (2).pdf", "Parcial 2008.pdf", "Resumen.docx"]
  );
  assert.equal(r1.descargados.length, 6);
  ok("expansión de carpetas, duplicados, extensión real, ignorados y fallidos");

  // Re-ejecución: todo se saltea
  const r2 = await descargarMateriales({ items, destino: dest, maxArchivos: 300, forzarRefresco: false }, deps);
  assert.equal(r2.descargados.length, 0);
  assert.equal(r2.salteados.length, 6);
  assert.equal(r2.bytes, 0);
  ok("saltea archivos que ya existen con el mismo tamaño");

  // Nada fuera del destino
  assert.ok(!fs.existsSync(path.join(tmp, "Escape.pdf")));
  assert.ok(!fs.existsSync(path.resolve(dest, "..", "..", "Escape.pdf")));
  const evil = await descargarMateriales(
    { items: [{ nombre: "ok", tipo: "folder", url: "https://eva/mod/folder/view.php?id=1" }], destino: path.join(tmp, "seg"), maxArchivos: 10, forzarRefresco: false },
    { ...deps, listFolderFiles: async () => [{ name: "..\\..\\..\\evil.pdf", url: "https://eva/pluginfile.php/x" }, { name: "../../evil2.pdf", url: "https://eva/pluginfile.php/y" }] }
  );
  assert.equal(evil.fallidos.length, 0);
  for (const f of fs.readdirSync(tmp)) assert.ok(!/evil/.test(f));
  assert.ok(!fs.existsSync(path.join(tmp, "evil.pdf")));
  ok("no escribe fuera de la carpeta destino");

  // Carpeta que no coincide con la búsqueda: solo archivos internos que coinciden
  const r3 = await descargarMateriales(
    {
      items: [{ nombre: "Material varios", tipo: "folder", url: "https://eva/mod/folder/view.php?id=3", coincide: false }],
      query: "RESUMEN",
      destino: path.join(tmp, "q"),
      maxArchivos: 10,
      forzarRefresco: false
    },
    deps
  );
  assert.deepEqual(r3.descargados, ["Material varios/Resumen.docx"]);
  ok("filtra archivos internos cuando la carpeta no coincide");

  // Límite
  const r4 = await descargarMateriales({ items, destino: path.join(tmp, "lim"), maxArchivos: 2, forzarRefresco: false }, deps);
  assert.equal(r4.descargados.length + r4.fallidos.length, 2 + 1); // 2 tareas + carpeta rota
  assert.ok(r4.omitidosPorLimite > 0);
  ok("respeta max_archivos");

  console.log("TEST MATERIALES OK");
} catch (e) {
  console.error("TEST MATERIALES FALLÓ:", e);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
