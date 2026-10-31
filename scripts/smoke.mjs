// Prueba de humo por STDIO: initialize + tools/list contra el servidor compilado.
// Verifica que stdout sea JSON-RPC puro y que los esquemas de entrada sean compatibles con Gemini/OpenAI/Cursor.
// Uso: node scripts/smoke.mjs [ruta/al/entry.js]
import { spawn } from "node:child_process";
import path from "node:path";

const entry = path.resolve(process.argv[2] || "build/src/index.js");
const FORBIDDEN_KEYS = new Set(["$schema", "additionalProperties", "$ref", "$defs", "definitions", "exclusiveMinimum", "exclusiveMaximum", "oneOf", "anyOf", "allOf", "not", "const", "patternProperties", "propertyNames"]);
const problems = [];

function scan(node, where) {
  if (Array.isArray(node)) return node.forEach((n, i) => scan(n, `${where}[${i}]`));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k)) problems.push(`${where}: palabra clave no portable '${k}'`);
      scan(v, `${where}.${k}`);
    }
  }
}

const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, UCA_MCP_SMOKE: "1" } });
let buf = "";
const messages = [];
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.jsonrpc !== "2.0") problems.push(`stdout: línea JSON sin jsonrpc 2.0: ${line.slice(0, 80)}`);
      messages.push(m);
    } catch {
      problems.push(`stdout contaminado (no JSON): ${line.slice(0, 80)}`);
    }
  }
});
child.stderr.on("data", () => {});

const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const waitFor = (id, ms = 20000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = messages.find((x) => x.id === id);
      if (m) { clearInterval(iv); resolve(m); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout esperando respuesta id=${id}`)); }
    }, 25);
  });

const t0 = Date.now();
try {
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const init = await waitFor(1);
  if (!init.result?.serverInfo?.name) problems.push("initialize sin serverInfo");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list", params: {} });
  const list = await waitFor(2);
  const tools = list.result?.tools ?? [];
  if (tools.length < 20) problems.push(`tools/list devolvió solo ${tools.length} herramientas`);
  for (const t of tools) {
    if (t.name.length > 64) problems.push(`${t.name}: nombre > 64 caracteres`);
    if (!/^[a-zA-Z0-9_-]+$/.test(t.name)) problems.push(`${t.name}: nombre con caracteres inválidos`);
    if ((t.description || "").length > 600) problems.push(`${t.name}: descripción > 600 caracteres`);
    if (t.inputSchema?.type !== "object") problems.push(`${t.name}: inputSchema.type != object`);
    scan(t.inputSchema, `${t.name}.inputSchema`);
    if (t.outputSchema) scan(t.outputSchema, `${t.name}.outputSchema`);
  }
  console.log(`tools: ${tools.length}, tiempo: ${Date.now() - t0} ms`);
} catch (e) {
  problems.push(String(e.message || e));
}
child.stdin.end();
setTimeout(() => child.kill(), 1500).unref();

if (problems.length) {
  console.error("SMOKE FALLÓ:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("SMOKE OK");
process.exit(0);
