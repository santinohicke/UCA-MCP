import { campusFetch, CampusSessionExpiredError } from "../shared/http.js";
import { logger } from "../shared/logger.js";

export interface CuotaInfo {
  concepto: string;
  periodo: string;
  monto?: string;
  fechaVencimiento?: string;
  estado: "Pagado" | "Pendiente" | "Vencido" | "Al día" | "Desconocido";
}

export interface TramiteInfo {
  id?: string;
  titulo: string;
  fechaInicio: string;
  estado: "Iniciado" | "En proceso" | "Finalizado" | "Rechazado" | string;
  detalle?: string;
}

export interface CampusInfo {
  aranceles: CuotaInfo[];
  tramites: TramiteInfo[];
  estadoAranceles?: string;
  saldo?: string;
  puedeCursar?: boolean;
  puedeRendir?: boolean;
  errores?: {
    aranceles?: string;
    tramites?: string;
  };
}

// Mapea el texto de estado a los valores tipados de CuotaInfo sin falsos positivos en impago/no pagado
export function parseEstadoCuota(raw: string): CuotaInfo["estado"] {
  const s = raw.toLowerCase().trim();
  if (!s) return "Desconocido";
  // Exclusiones explícitas de "sin deuda" antes de chequear la palabra "deuda"
  if (s.includes("sin deuda") || s.includes("no adeuda") || s.includes("libre de deuda")) {
    return "Pagado";
  }
  if (s.includes("al dia") || s.includes("al día")) {
    return "Al día";
  }
  // Casos negativos o de deuda impaga primero para evitar que 'impago' o 'no pagado' coincidan con 'pag'
  if (s.includes("no pag") || s.includes("impag") || s.includes("deuda") || s.includes("a pagar")) {
    return "Pendiente";
  }
  if (s.includes("a vencer") || s.includes("no venc") || s.includes("sin vencer")) {
    return "Pendiente";
  }
  if (s.includes("venc")) {
    return "Vencido";
  }
  if (s.includes("pend")) {
    return "Pendiente";
  }
  if (s.includes("pagad") || s.includes("abonad") || s.includes("cobrad") || s === "pagado" || s === "pago") {
    return "Pagado";
  }
  return "Desconocido";
}

async function campusJson(path: string): Promise<unknown> {
  const res = await campusFetch(path, { headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) throw new CampusSessionExpiredError();
  if (!res.ok) throw new Error(`Campus Autogestión respondió HTTP ${res.status} en ${path}.`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.includes("Acceso al Campus")) throw new CampusSessionExpiredError();
    throw new Error(`Campus Autogestión devolvió una respuesta no JSON en ${path}.`);
  }
}

function formatMonto(saldo: string): string {
  const n = Number(saldo);
  if (!Number.isFinite(n)) return saldo;
  return `$ ${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Aranceles: el portal es una SPA que consume /api/aranceles (saldo + habilitaciones para cursar/rendir)
export function parseAranceles(raw: unknown): Pick<CampusInfo, "aranceles" | "estadoAranceles" | "saldo" | "puedeCursar" | "puedeRendir"> {
  const obj = (raw ?? {}) as Record<string, any>;
  const data = obj.data && typeof obj.data === "object" ? obj.data : obj;
  const saldoRaw = data.debt ?? data.saldo;
  if (saldoRaw === undefined || saldoRaw === null || Number.isNaN(Number(saldoRaw))) {
    throw new Error("Campus Autogestión no devolvió un saldo reconocible. Consultá directamente en https://autogestion.uca.edu.ar.");
  }
  const saldoNum = Number(saldoRaw);
  const puedeCursar = data.canCourse ?? data.puede_cursar;
  const puedeRendir = data.canExam ?? data.puede_rendir;
  const conDeuda = saldoNum > 0;
  return {
    aranceles: [
      {
        concepto: "Cuenta corriente arancelaria",
        periodo: "Saldo actual",
        monto: formatMonto(String(saldoRaw)),
        estado: conDeuda ? "Pendiente" : "Al día"
      }
    ],
    estadoAranceles: conDeuda ? "Con deuda pendiente" : "Al día",
    saldo: String(saldoRaw),
    puedeCursar: typeof puedeCursar === "boolean" ? puedeCursar : undefined,
    puedeRendir: typeof puedeRendir === "boolean" ? puedeRendir : undefined
  };
}

// Trámites: /api/tramites devuelve un array (vacío si no hay trámites)
export function parseTramites(raw: unknown): TramiteInfo[] {
  if (!Array.isArray(raw)) {
    throw new Error("Campus Autogestión devolvió un formato de trámites no reconocido. Consultá directamente en https://autogestion.uca.edu.ar.");
  }
  return raw.map((t: any, idx: number) => ({
    id: String(t.tramite_id ?? t.id ?? `tramite-${idx + 1}`),
    titulo: t.name ?? t.titulo ?? "Trámite administrativo",
    fechaInicio: t.created_at ?? t.createdAt ?? "",
    estado: t.estado ?? t.status ?? "EN CURSO",
    detalle: t.etapa ?? t.stage ?? undefined
  }));
}

// Consulta de aranceles y estado de trámites administrativos en Campus Autogestión (Estricto Read-Only)
export async function getArancelesYTramites(
  consulta: "todo" | "aranceles" | "tramites" = "todo"
): Promise<CampusInfo> {
  const result: CampusInfo = { aranceles: [], tramites: [] };
  let arancelesError: unknown;
  let tramitesError: unknown;

  if (consulta === "todo" || consulta === "aranceles") {
    try {
      Object.assign(result, parseAranceles(await campusJson("/api/aranceles")));
    } catch (err) {
      logger.error(`No se pudieron obtener aranceles en Campus Autogestión: ${err}`);
      arancelesError = err;
      if (consulta === "aranceles") throw err;
      result.estadoAranceles = "Error al consultar aranceles";
      result.errores = { ...result.errores, aranceles: err instanceof Error ? err.message : String(err) };
    }
  }

  if (consulta === "todo" || consulta === "tramites") {
    try {
      result.tramites = parseTramites(await campusJson("/api/tramites"));
    } catch (err) {
      logger.error(`No se pudieron obtener trámites en Campus Autogestión: ${err}`);
      tramitesError = err;
      if (consulta === "tramites") throw err;
      result.errores = { ...result.errores, tramites: err instanceof Error ? err.message : String(err) };
    }
  }

  if (consulta === "todo" && arancelesError && tramitesError) {
    throw arancelesError;
  }

  return result;
}
