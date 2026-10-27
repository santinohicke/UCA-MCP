import { getTareasYNotas, getForos, type TareaInfo, type ForoItem } from "../eva/client.js";
import { getEstadoCursada, type CursadaInfo } from "../guarani/client.js";

export interface ResumenSemanalInfo {
  fechaGeneracion: string;
  tareasProximas: TareaInfo[];
  avisosRecientes: ForoItem[];
  estadoCursada: CursadaInfo[];
  alertas: string[];
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

  return {
    fechaGeneracion: new Date().toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires"
    }),
    tareasProximas,
    avisosRecientes,
    estadoCursada,
    alertas
  };
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
