import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { getTareasYNotas, getForos, type TareaInfo, type ForoItem } from "../eva/client.js";
import { getEstadoCursada, type CursadaInfo } from "../guarani/client.js";

export interface ResumenSnapshotData {
  timestamp: number;
  knownTaskIds: number[];
  knownForumPostIds: number[];
}

export interface ResumenNovedades {
  nuevasTareas: Array<{ id: number; nombre: string; materia?: string }>;
  nuevosAvisos: Array<{ id: number; asunto: string; autor?: string }>;
}

export interface ResumenSemanalInfo {
  fechaGeneracion: string;
  tareasProximas: TareaInfo[];
  avisosRecientes: ForoItem[];
  estadoCursada: CursadaInfo[];
  alertas: string[];
  novedades?: ResumenNovedades;
}

// Genera un resumen semanal consolidado consultando EVA y SIU Guaraní en paralelo
export async function getResumenSemanal(carrera?: string): Promise<ResumenSemanalInfo> {
  const alertas: string[] = [];

  const [tareasRes, forosRes, cursadaRes] = await Promise.allSettled([
    getTareasYNotas(undefined, false),
    getForos(undefined, 5),
    getEstadoCursada(carrera)
  ]);

  const tareasProximas = tareasRes.status === "fulfilled" ? tareasRes.value : [];
  if (tareasRes.status === "rejected") {
    const err = tareasRes.reason instanceof Error ? tareasRes.reason.message : String(tareasRes.reason);
    alertas.push(`⚠️ Error al sincronizar tareas de EVA: ${err}`);
  }

  const avisosRecientes = forosRes.status === "fulfilled" ? forosRes.value : [];
  if (forosRes.status === "rejected") {
    const err = forosRes.reason instanceof Error ? forosRes.reason.message : String(forosRes.reason);
    alertas.push(`⚠️ Error al sincronizar avisos de foros de EVA: ${err}`);
  }

  const estadoCursada = cursadaRes.status === "fulfilled" ? cursadaRes.value : [];
  if (cursadaRes.status === "rejected") {
    const err = cursadaRes.reason instanceof Error ? cursadaRes.reason.message : String(cursadaRes.reason);
    alertas.push(`⚠️ Error al sincronizar cursada e inasistencias de SIU Guaraní: ${err}`);
  }

  alertas.push(...generarAlertasTareas(tareasProximas));

  // Detección de novedades comparando con snapshot anterior
  let novedades: ResumenNovedades | undefined;
  const snapshotPath = path.join(CONFIG.CACHE_DIR, "resumen_snapshot.json");
  try {
    if (fs.existsSync(snapshotPath)) {
      const prev: ResumenSnapshotData = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
      const prevTasks = new Set(prev.knownTaskIds || []);
      const prevForums = new Set(prev.knownForumPostIds || []);

      const nuevasTareas = tareasProximas
        .filter((t) => !prevTasks.has(t.id))
        .map((t) => ({ id: t.id, nombre: t.nombre, materia: t.materiaNombre }));
      const nuevosAvisos = avisosRecientes
        .filter((a) => !prevForums.has(a.id))
        .map((a) => ({ id: a.id, asunto: a.asunto, autor: a.autor }));

      if (nuevasTareas.length > 0 || nuevosAvisos.length > 0) {
        novedades = { nuevasTareas, nuevosAvisos };
        if (nuevasTareas.length > 0) {
          alertas.push(`🔔 ${nuevasTareas.length} tarea(s) nueva(s) detectada(s) desde el último resumen.`);
        }
        if (nuevosAvisos.length > 0) {
          alertas.push(`🔔 ${nuevosAvisos.length} aviso(s) nuevo(s) detectado(s) en foros desde el último resumen.`);
        }
      }
    }
  } catch {}

  // Guardar snapshot actualizado
  try {
    const currentSnapshot: ResumenSnapshotData = {
      timestamp: Math.floor(Date.now() / 1000),
      knownTaskIds: tareasProximas.map((t) => t.id),
      knownForumPostIds: avisosRecientes.map((a) => a.id)
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2), "utf-8");
  } catch {}

  // Resumen compacto para optimizar tokens y latencia del LLM (omite texto extenso de tareas e historial detallado de inasistencias)
  const compactTareas = tareasProximas.map(({ descripcion, ...t }) => t);
  const compactCursada = estadoCursada.map(({ detalleInasistencias, ...c }) => c);

  return JSON.parse(
    JSON.stringify({
      fechaGeneracion: new Date().toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires"
      }),
      tareasProximas: compactTareas,
      avisosRecientes,
      estadoCursada: compactCursada,
      alertas,
      novedades
    })
  );
}

// Genera alertas semánticas para tareas pendientes y vencidas
export function generarAlertasTareas(
  tareasProximas: TareaInfo[],
  nowUnix = Math.floor(Date.now() / 1000)
): string[] {
  const alertas: string[] = [];
  const unaSemanaUnix = nowUnix + 7 * 86400;

  const urgentes = tareasProximas.filter(
    (t) =>
      t.fechaLimiteUnix >= nowUnix &&
      t.fechaLimiteUnix <= unaSemanaUnix &&
      t.estadoEntrega !== "Enviado para calificar" &&
      t.estadoEntrega !== "Calificada"
  );

  if (urgentes.length > 0) {
    alertas.push(`Tenés ${urgentes.length} tarea(s) con vencimiento dentro de los próximos 7 días.`);
  }

  const vencidas = tareasProximas.filter(
    (t) =>
      t.fechaLimiteUnix > 0 &&
      t.fechaLimiteUnix < nowUnix &&
      t.estadoEntrega !== "Enviado para calificar" &&
      t.estadoEntrega !== "Calificada" &&
      t.estadoEntrega !== "desconocido"
  );
  if (vencidas.length > 0) {
    alertas.push(`Tenés ${vencidas.length} tarea(s) con fecha límite vencida sin registrar entrega.`);
  }

  return alertas;
}
