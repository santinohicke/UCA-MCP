import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { getSessionUserKey, registerSessionPurgeHook } from "../auth/session.js";
import { SessionExpiredError } from "../shared/http.js";
import { getArancelesYTramites } from "../campus/client.js";
import { getTareasYNotas, getForos, type TareaInfo, type ForoItem } from "../eva/client.js";
import {
  getEstadoCursada,
  getHorarioSemanal,
  getMisInscripcionesExamen,
  withGuaraniLock,
  type CursadaInfo,
  type ClaseHorario,
  type MesaExamenInfo
} from "../guarani/client.js";

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
  clasesHoy?: ClaseHorario[];
  examenesInscriptos?: MesaExamenInfo[];
  puedeCursar?: boolean;
  puedeRendir?: boolean;
  sesionExpirada?: boolean;
  // Datos complementarios que no se pudieron obtener (tiempo agotado o error): nunca se omiten en silencio
  datosFaltantes?: string[];
  alertas: string[];
  novedades?: ResumenNovedades;
}

// Limita el tiempo de espera de datos complementarios para que nunca demoren el resumen principal
function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tiempo de espera agotado")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Igual que conTimeout pero para consultas que usan el mutex de Guaraní: el contador arranca recién cuando se
// toma el lock (no cuenta la espera en cola). El lock se mantiene hasta que la consulta termina (no queda
// ninguna petición suelta ejecutándose fuera del lock), pero quien llama recibe el error de tiempo al vencer.
function conTimeoutEnLock<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    withGuaraniLock(async () => {
      const inner = fn();
      inner.catch(() => {});
      const timer = setTimeout(() => reject(new Error("tiempo de espera agotado")), ms);
      try {
        resolve(await inner);
      } catch (err) {
        reject(err);
      } finally {
        clearTimeout(timer);
      }
    }).catch(reject);
  });
}

function motivo(r: PromiseRejectedResult): string {
  return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

// Snapshot por usuario (hash del email) con escritura atómica
function snapshotPathDeUsuario(): string {
  return path.join(CONFIG.CACHE_DIR, `resumen_snapshot_${getSessionUserKey()}.json`);
}

function escribirSnapshotAtomico(filePath: string, data: ResumenSnapshotData): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Al cerrar sesión se purga todo CACHE_DIR; además se borra el snapshot de la sesión actual por las dudas
registerSessionPurgeHook(() => {
  try {
    fs.unlinkSync(snapshotPathDeUsuario());
  } catch {}
});

// Genera un resumen semanal consolidado consultando EVA y SIU Guaraní en paralelo
export async function getResumenSemanal(carrera?: string): Promise<ResumenSemanalInfo> {
  const alertas: string[] = [];

  const [tareasRes, forosRes, cursadaRes, hoyRes, examenesRes, campusRes] = await Promise.allSettled([
    getTareasYNotas(undefined, false),
    conTimeout(getForos(undefined, 10).then((f) => f.slice(0, 5)), 10000),
    getEstadoCursada(carrera),
    conTimeoutEnLock(() => getHorarioSemanal(carrera, "hoy"), 8000),
    conTimeoutEnLock(() => getMisInscripcionesExamen(carrera), 8000),
    conTimeout(getArancelesYTramites("aranceles"), 6000)
  ]);

  const principales = [tareasRes, forosRes, cursadaRes];
  const sesionExpirada =
    principales.every((r) => r.status === "rejected") &&
    principales.some((r) => r.status === "rejected" && r.reason instanceof SessionExpiredError);

  const tareasProximas = tareasRes.status === "fulfilled" ? tareasRes.value : [];
  if (tareasRes.status === "rejected") {
    const err = tareasRes.reason instanceof Error ? tareasRes.reason.message : String(tareasRes.reason);
    alertas.push(`⚠️ Error al sincronizar tareas de EVA: ${err}`);
  }

  const avisosRecientes = forosRes.status === "fulfilled" ? forosRes.value : [];
  if (forosRes.status === "rejected") {
    const err = forosRes.reason instanceof Error ? forosRes.reason.message : String(forosRes.reason);
    alertas.push(`⚠️ No se pudieron cargar los avisos de foros de EVA a tiempo (${err}); reintentá en unos segundos.`);
  }

  const estadoCursada = cursadaRes.status === "fulfilled" ? cursadaRes.value : [];
  if (cursadaRes.status === "rejected") {
    const err = cursadaRes.reason instanceof Error ? cursadaRes.reason.message : String(cursadaRes.reason);
    alertas.push(`⚠️ Error al sincronizar cursada e inasistencias de SIU Guaraní: ${err}`);
  }

  // Datos complementarios: si fallan o demoran se avisa explícitamente qué datos faltaron
  const datosFaltantes: string[] = [];
  if (hoyRes.status === "rejected") datosFaltantes.push(`clases de hoy (${motivo(hoyRes)})`);
  if (examenesRes.status === "rejected") datosFaltantes.push(`inscripciones a examen (${motivo(examenesRes)})`);
  if (campusRes.status === "rejected") datosFaltantes.push(`situación de aranceles (${motivo(campusRes)})`);
  if (examenesRes.status === "fulfilled" && examenesRes.value.parcial) {
    datosFaltantes.push("inscripciones a examen (lectura incompleta de Guaraní)");
  }
  if (datosFaltantes.length > 0) {
    alertas.push(`⚠️ No se pudieron obtener estos datos: ${datosFaltantes.join("; ")}. Reintentá en unos segundos.`);
  }
  const clasesHoy = hoyRes.status === "fulfilled" ? hoyRes.value.clases : undefined;
  const examenesInscriptos =
    examenesRes.status === "fulfilled" && examenesRes.value.inscripciones.length > 0
      ? examenesRes.value.inscripciones
      : undefined;
  if (examenesInscriptos) {
    alertas.push(`Tenés ${examenesInscriptos.length} inscripción(es) activa(s) a examen final.`);
  }

  const puedeCursar = campusRes.status === "fulfilled" ? campusRes.value.puedeCursar : undefined;
  const puedeRendir = campusRes.status === "fulfilled" ? campusRes.value.puedeRendir : undefined;
  if (puedeCursar === false || puedeRendir === false) {
    alertas.push("Tu situación administrativa (aranceles) te inhabilita para " + [puedeCursar === false ? "cursar" : "", puedeRendir === false ? "rendir" : ""].filter(Boolean).join(" y ") + ".");
  }

  alertas.push(...generarAlertasTareas(tareasProximas));

  // Detección de novedades comparando con snapshot anterior
  let novedades: ResumenNovedades | undefined;
  const snapshotPath = snapshotPathDeUsuario();
  let prevSnapshot: ResumenSnapshotData | undefined;
  try {
    if (fs.existsSync(snapshotPath)) {
      prevSnapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
      const prevTasks = new Set(prevSnapshot?.knownTaskIds || []);
      const prevForums = new Set(prevSnapshot?.knownForumPostIds || []);

      const nuevasTareas = (tareasRes.status === "fulfilled" ? tareasProximas : [])
        .filter((t) => !prevTasks.has(t.id))
        .map((t) => ({ id: t.id, nombre: t.nombre, materia: t.materiaNombre }));
      const nuevosAvisos = (forosRes.status === "fulfilled" ? avisosRecientes : [])
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

  // Guardar snapshot actualizado (preservando IDs de fuentes que hayan fallado). Si ambas fuentes fallaron
  // no se toca el snapshot anterior.
  try {
    if (tareasRes.status === "rejected" && forosRes.status === "rejected") throw new Error("sin datos nuevos");
    const currentSnapshot: ResumenSnapshotData = {
      timestamp: Math.floor(Date.now() / 1000),
      knownTaskIds:
        tareasRes.status === "fulfilled"
          ? tareasProximas.map((t) => t.id)
          : prevSnapshot?.knownTaskIds || [],
      knownForumPostIds:
        forosRes.status === "fulfilled"
          ? avisosRecientes.map((a) => a.id)
          : prevSnapshot?.knownForumPostIds || []
    };
    escribirSnapshotAtomico(snapshotPath, currentSnapshot);
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
      clasesHoy,
      examenesInscriptos,
      puedeCursar,
      puedeRendir,
      sesionExpirada: sesionExpirada || undefined,
      datosFaltantes: datosFaltantes.length > 0 ? datosFaltantes : undefined,
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
