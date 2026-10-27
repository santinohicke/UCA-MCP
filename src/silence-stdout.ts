import { Writable } from "node:stream";

// Referencia original a la salida estándar real del proceso
export const rawStdoutWrite = process.stdout.write.bind(process.stdout);

// Redirige cualquier escritura directa o de librerías de terceros hacia stderr
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

// Stream Writable exclusivo para el transporte MCP Stdio
export const mcpStdoutStream = new Writable({
  write(chunk, encoding, callback) {
    rawStdoutWrite(chunk, encoding, callback);
  }
});
