import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { guaraniFetch, guaraniMutex } from "../shared/http.js";
import { logger } from "../shared/logger.js";
import { loadEncryptedSession, saveEncryptedSession, registerSessionPurgeHook } from "../auth/session.js";
import { withInterProcessLock } from "../auth/session-store.js";
import { CONFIG } from "../config.js";

// Bloqueo combinado intra-proceso (guaraniMutex) e inter-proceso (guarani.lock)
// Si ya estamos dentro del mutex (llamada re-entrante), se omite el file lock para evitar deadlock.
export async function withGuaraniLock<T>(fn: () => Promise<T>): Promise<T> {
  if (guaraniMutex.isInsideLock()) return fn();
  return guaraniMutex.runExclusive(() => {
    const lockPath = path.join(CONFIG.BASE_DIR, "guarani.lock");
    return withInterProcessLock(lockPath, fn);
  });
}

export interface InasistenciaDetalle {
  fecha: string;
  tipoClase: string;
  tema?: string;
  cantidad: number;
  justificada: boolean;
}

export interface CalculoFaltas {
  porcentajeAsistencia: number;
  inasistenciasTotales: number;
  porcentajeDescontadoPorFalta?: number;
  clasesTotalesEstimadas?: number;
  faltasPermitidasTotales?: number;
  faltasRestantesParaQuedarLibre?: number;
  estadoAsistencia: "Normal" | "Al límite" | "Libre" | "Sin faltas registradas";
  mensajeCalculo: string;
}

export interface CursadaInfo {
  materia: string;
  codigo?: string;
  comision?: string;
  condicion: string;
  asistencia?: string;
  inasistencias?: number;
  calculoFaltas?: CalculoFaltas;
  detalleInasistencias?: InasistenciaDetalle[];
  horario?: string;
  docentes?: string;
}

export function calcularFaltas(porcentajeAsistencia: number, inasistencias: number): CalculoFaltas {
  if (inasistencias <= 0 || porcentajeAsistencia >= 100) {
    return {
      porcentajeAsistencia: 100,
      inasistenciasTotales: 0,
      estadoAsistencia: "Sin faltas registradas",
      mensajeCalculo:
        "No registrás inasistencias en esta materia (100% de asistencia). Al no haber faltas computadas en Guaraní, no se puede calcular con exactitud cuántas faltas restan hasta quedar libre porque se desconoce el porcentaje que descuenta cada clase en esta comisión."
    };
  }

  const porcentajePerdido = Math.max(0, 100 - porcentajeAsistencia);
  const porcentajeDescontadoPorFalta = Number((porcentajePerdido / inasistencias).toFixed(2));
  const clasesTotalesEstimadas = Math.round(100 / (porcentajePerdido / inasistencias));

  // Regularidad UCA: Asistencia >= 75%. Queda libre si la asistencia cae por debajo del 75% (pérdida > 25%)
  const faltasPermitidasTotales = Math.floor(25 / (porcentajePerdido / inasistencias));
  const faltasRestantesParaQuedarLibre = Math.max(0, faltasPermitidasTotales - inasistencias);

  let estadoAsistencia: CalculoFaltas["estadoAsistencia"] = "Normal";
  if (porcentajeAsistencia < 75) {
    estadoAsistencia = "Libre";
  } else if (faltasRestantesParaQuedarLibre <= 2) {
    estadoAsistencia = "Al límite";
  }

  const mensajeCalculo =
    porcentajeAsistencia < 75
      ? `Tenés ${inasistencias} inasistencia(s) (${porcentajeAsistencia}%). Quedaste en condición LIBRE al caer por debajo del 75% de asistencia requerido.`
      : `Tenés ${inasistencias} inasistencia(s) acumulada(s) (${porcentajeAsistencia}% de asistencia). Cada falta resta ~${porcentajeDescontadoPorFalta}% ` +
        `(sobre unas ${clasesTotalesEstimadas} clases estimadas en el cuatrimestre). Te quedan ${faltasRestantesParaQuedarLibre} falta(s) antes de quedar libre (<75%).`;

  return {
    porcentajeAsistencia,
    inasistenciasTotales: inasistencias,
    porcentajeDescontadoPorFalta,
    clasesTotalesEstimadas,
    faltasPermitidasTotales,
    faltasRestantesParaQuedarLibre,
    estadoAsistencia,
    mensajeCalculo
  };
}

export interface MateriaAprobada {
  materia: string;
  codigo?: string;
  fecha: string;
  nota: string | number;
  tipo: "Examen" | "Promoción" | "Equivalencia" | "Otro";
  libro?: string;
  folio?: string;
}

export interface HistoriaAcademicaInfo {
  carrera?: string;
  carrerasDisponibles?: string[];
  promedioSinAplazos?: number;
  promedioConAplazos?: number;
  porcentajeAvance?: number;
  totalAprobadas: number;
  materiasAprobadas: MateriaAprobada[];
  materiasRegulares: Array<{
    materia: string;
    fecha: string;
    vencimiento?: string;
  }>;
}

export interface MesaExamenInfo {
  materia: string;
  codigo?: string;
  llamadoId: string;
  fecha?: string;
  hora?: string;
  tribunal?: string;
  condicionPermitida?: "Regular" | "Libre" | "Ambas" | "No verificado";
  inscripcionAbierta: boolean;
}

const NON_DEGREE_PATTERN = /tutor|ingreso|bachiller/i;

export interface CorrelativaRequisito {
  materia: string;
  codigo?: string;
  condicionRequerida: "Regularizada" | "Aprobada";
  estadoActual?: "Aprobada" | "Promocionada" | "Regularizada" | "Cursando" | "Pendiente";
  cumple?: boolean;
}

export interface MateriaPlan {
  nombre: string;
  codigo: string;
  anio: number;
  periodo: string;
  tipo: string;
  estado: "Aprobada" | "Promocionada" | "Regularizada" | "Cursando" | "Pendiente";
  nota?: string | number;
  origen?: string;
  creditos?: string;
  puntaje?: string;
  elementoId?: string;
  elementoPadreId?: string;
  correlativasParaCursar?: CorrelativaRequisito[];
  correlativasParaAprobar?: CorrelativaRequisito[];
  materiasQueDependenDeEsta?: Array<{
    materia: string;
    codigo: string;
    anio: number;
    requierePara: "Cursar" | "Aprobar";
  }>;
}

export interface PlanEstudiosInfo {
  propuesta?: string;
  plan?: string;
  version?: string;
  materias: MateriaPlan[];
  analisisMateria?: MateriaPlan;
  resumenImpacto?: string;
  analisisCompleto?: boolean;
  materiasSinVerificar?: number;
  materiasHabilitadasParaCursar?: MateriaPlan[];
}

// Desenvuelve respuestas de Guaraní Chulupi (JSON con propiedad {cont} o scripts de renderizado on_arrival)
export function unwrapChulupiHtml(rawText: string): string {
  let text = rawText;
  try {
    const j = JSON.parse(text);
    if (j && typeof j.cont === "string") text = j.cont;
  } catch {}

  const match = text.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);/);
  if (match) {
    try {
      const raw = match[1];
      const parsed = JSON.parse(raw);
      if (parsed?.content) return parsed.content;
    } catch {
      try {
        const unescaped = match[1]
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\");
        const parsed = JSON.parse(unescaped);
        if (parsed?.content) return parsed.content;
      } catch {}
    }
  }

  return text;
}

// Parser puro para estado de cursadas activas
export function parseCursadas(html: string): CursadaInfo[] {
  const $ = cheerio.load(html);
  const cursadas: CursadaInfo[] = [];

  $(".cuadro, .cursada-item, tr.fila-cursada, .card-cursada").each((_, el) => {
    const materia =
      $(el).find(".materia-nombre, .nombre, td.materia, h4, strong").first().text().trim();
    if (!materia) return;

    const comision = $(el).find(".comision, td.comision").first().text().trim() || undefined;
    const condicion =
      $(el).find(".condicion, td.condicion").first().text().trim() || "Cursando";
    const asistencia = $(el).find(".asistencia, td.asistencia").first().text().trim() || undefined;
    const inasistenciasText = $(el).find(".inasistencias, td.faltas").first().text().trim();
    const inasistenciasMatch = /\d+/.exec(inasistenciasText);
    const inasistencias = inasistenciasMatch ? parseInt(inasistenciasMatch[0], 10) : undefined;
    const horario = $(el).find(".horario, td.horario").first().text().trim() || undefined;
    const docentes = $(el).find(".docentes, td.docentes").first().text().trim() || undefined;

    let calculoFaltas: CalculoFaltas | undefined;
    if (asistencia) {
      const pctMatch = /(\d+(?:[.,]\d+)?)/.exec(asistencia);
      if (pctMatch) {
        calculoFaltas = calcularFaltas(parseFloat(pctMatch[1].replace(",", ".")), inasistencias || 0);
      }
    }

    cursadas.push({
      materia,
      comision,
      condicion,
      asistencia,
      inasistencias,
      calculoFaltas,
      horario,
      docentes
    });
  });

  if (cursadas.length === 0) {
    $("table").each((_, tbl) => {
      const headerText = $(tbl).find("th, thead").text().toLowerCase();
      const hasAcademicHeaders =
        /materia|asignatura|actividad/i.test(headerText) &&
        /condici[oó]n|estado|comisi[oó]n/i.test(headerText);

      // Solo parsear tablas con cabeceras académicas o tablas de datos excluyendo tablas de perfil/metadatos
      if (hasAcademicHeaders || (!headerText && $(tbl).find("tr").length > 1)) {
        $(tbl).find("tbody tr, tr").each((__, tr) => {
          if ($(tr).find("th").length > 0) return;
          const cells = $(tr).find("td").map((___, td) => $(td).text().trim()).get();
          if (cells.length >= 3 && cells[0]) {
            if (/^(usuario|legajo|carrera|facultad|documento|email|sede)[:\s]/i.test(cells[0])) return;
            cursadas.push({
              materia: cells[0],
              condicion: cells[1] || "Regular",
              asistencia: cells[2] || undefined,
              horario: cells[3] || undefined
            });
          }
        });
      }
    });
  }

  return cursadas;
}

export interface InasistenciasMateriaParsed {
  codigo?: string;
  materia: string;
  comision?: string;
  porcentajeAsistencia: number;
  inasistenciasTotales: number;
  detalles: InasistenciaDetalle[];
}

// Parser puro para reporte de inasistencias de SIU Guaraní
export function parseReporteInasistencias(html: string): InasistenciasMateriaParsed[] {
  const $ = cheerio.load(html);
  const items: InasistenciasMateriaParsed[] = [];

  $(".actividad").each((_, el) => {
    const leftText = $(el).find(".titulo-corte .pull-left").text().replace(/\s+/g, " ").trim();
    const rightText = $(el).find(".titulo-corte .pull-right").text().replace(/\s+/g, " ").trim();

    const codMatch = /\(([A-Z0-9]+)\)\s*([^-]+)(?:-\s*Comisi[oó]n:\s*(.*))?/i.exec(leftText);
    const codigo = codMatch ? codMatch[1].trim() : undefined;
    const materia = codMatch ? codMatch[2].trim() : leftText;
    const comision = codMatch && codMatch[3] ? codMatch[3].trim() : undefined;

    const pctMatch = /(\d+(?:[.,]\d+)?)/.exec(rightText);
    const porcentajeAsistencia = pctMatch ? parseFloat(pctMatch[1].replace(",", ".")) : 100;

    const detalles: InasistenciaDetalle[] = [];
    $(el).find("table.comisiones tr").each((__, tr) => {
      if ($(tr).hasClass("titulo") || $(tr).find("th").length > 0) return;
      const tds = $(tr).find("td");
      if (tds.length >= 4) {
        const fecha = tds.eq(0).text().trim();
        if (!fecha) return;
        const tipoClase = tds.eq(1).text().trim() || "Teórico";
        const tema = tds.eq(2).text().trim() || undefined;
        const cantStr = tds.eq(3).text().trim();
        const cant = parseFloat(cantStr) || 1;
        const justStr = tds.eq(4).text().trim().toLowerCase();
        const justificada = justStr === "si" || justStr === "sí";

        detalles.push({
          fecha,
          tipoClase,
          tema,
          cantidad: cant,
          justificada
        });
      }
    });

    // Solo contar las no-justificadas para calcularFaltas (las justificadas no descuentan asistencia)
    const inasistenciasTotales = detalles.filter((d) => !d.justificada).reduce((sum, d) => sum + d.cantidad, 0);

    items.push({
      codigo,
      materia,
      comision,
      porcentajeAsistencia,
      inasistenciasTotales,
      detalles
    });
  });

  return items;
}

// Parser puro para asignaciones de cursadas desde /calendario
export function parseCalendarioAsignaciones(rawText: string): CursadaInfo[] {
  let asignaciones: any[] = [];
  try {
    const j = JSON.parse(rawText);
    const cont = typeof j?.cont === "string" ? j.cont : rawText;
    const match = cont.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);/);
    if (match) {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data?.info?.asignaciones)) {
        asignaciones = data.info.asignaciones;
      }
    }
  } catch {}

  const diasMap: Record<string, string> = {
    "1": "Domingo",
    "2": "Lunes",
    "3": "Martes",
    "4": "Miércoles",
    "5": "Jueves",
    "6": "Viernes",
    "7": "Sábado"
  };

  const materiasMap = new Map<
    string,
    {
      materia: string;
      codigo?: string;
      comision?: string;
      horarios: string[];
    }
  >();

  for (const asig of asignaciones) {
    const matName = asig.NOMBRE_MATERIA?.trim();
    if (!matName) continue;
    const matCod = asig.MATERIA?.trim();
    const key = matCod || matName;

    if (!materiasMap.has(key)) {
      materiasMap.set(key, {
        materia: matName,
        codigo: matCod,
        comision: asig.NOMBRE?.trim(),
        horarios: []
      });
    }

    const item = materiasMap.get(key)!;
    const dia = (asig.DIA_SEMANA && diasMap[asig.DIA_SEMANA]) || `Día ${asig.DIA_SEMANA || "?"}`;
    const desde = asig.HS_COMIENZO_CLASE?.slice(0, 5) || "";
    const hasta = asig.HS_FINALIZ_CLASE?.slice(0, 5) || "";
    const tipo = asig.TIPO_CLASE ? ` (${asig.TIPO_CLASE})` : "";
    const aula = asig.AULA ? ` - ${asig.AULA}` : "";
    const horStr = `${dia} ${desde}-${hasta}${tipo}${aula}`.trim();
    if (horStr && !item.horarios.includes(horStr)) {
      item.horarios.push(horStr);
    }
  }

  const cursadas: CursadaInfo[] = [];
  for (const [, val] of materiasMap) {
    cursadas.push({
      materia: val.materia,
      codigo: val.codigo,
      comision: val.comision,
      condicion: "Cursando",
      horario: val.horarios.join(" | ") || undefined
    });
  }

  return cursadas;
}

// Parser puro para analítico e historia académica
export function parseHistoriaAcademica(
  html: string,
  options: { carreraActiva?: string; carrerasDisponibles?: string[] } = {}
): HistoriaAcademicaInfo {
  const $ = cheerio.load(html);
  const materiasAprobadas: MateriaAprobada[] = [];
  const materiasRegulares: HistoriaAcademicaInfo["materiasRegulares"] = [];

  $("table.tabla-historia tbody tr, table.items tbody tr, table.table tbody tr, table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
    if (tds.length >= 4) {
      const materia = tds[0] || "";
      const fecha = tds[1] || "";
      const tipoRaw = (tds[2] || "").toLowerCase();
      const notaRaw = tds[3] || "";

      let tipo: MateriaAprobada["tipo"] = "Otro";
      if (tipoRaw.includes("prom")) tipo = "Promoción";
      else if (tipoRaw.includes("exam") || tipoRaw.includes("fin")) tipo = "Examen";
      else if (tipoRaw.includes("equiv")) tipo = "Equivalencia";

      const notaNum = parseFloat(notaRaw.replace(",", "."));
      const nota = !isNaN(notaNum) ? notaNum : notaRaw;

      // En UCA y SIU Guaraní la nota mínima de aprobación es 4; notas inferiores o leyendas de reprobado son aplazos
      const esAprobada = !isNaN(notaNum)
        ? notaNum >= 4
        : !/reprob|desaprob|insuf|ausent|no\s*apro/i.test(notaRaw) && !/reprob|desaprob|insuf|ausent|no\s*apro/i.test(tipoRaw);

      if (tipoRaw.includes("reg")) {
        materiasRegulares.push({
          materia,
          fecha,
          vencimiento: tds[4] || undefined
        });
      } else if (notaRaw && esAprobada) {
        materiasAprobadas.push({
          materia,
          fecha,
          nota,
          tipo,
          libro: tds[4] || undefined,
          folio: tds[5] || undefined
        });
      }
    }
  });

  const textSummary = $(".resumen-historia, .promedios, #promedio, .info-avance").text() || $("body").text();
  const sinAplazosMatch = /sin\s+aplazos?[:\s]+([\d.,]+)/i.exec(textSummary);
  const conAplazosMatch = /con\s+aplazos?[:\s]+([\d.,]+)/i.exec(textSummary);
  const avanceMatch =
    /(?:porcentaje|avance)[\s\w]*?[:\s]+([\d.,]+)\s*%/i.exec(textSummary) ||
    /([\d.,]+)\s*%\s*(?:de avance|completado|aprobado)/i.exec(textSummary);

  const promedioSinAplazos = sinAplazosMatch
    ? parseFloat(sinAplazosMatch[1].replace(",", "."))
    : undefined;
  const promedioConAplazos = conAplazosMatch
    ? parseFloat(conAplazosMatch[1].replace(",", "."))
    : undefined;
  const porcentajeAvance = avanceMatch
    ? parseFloat(avanceMatch[1].replace(",", "."))
    : undefined;

  return {
    carrera: options.carreraActiva || extractActiveCareerFromHtml(html),
    carrerasDisponibles: options.carrerasDisponibles,
    promedioSinAplazos,
    promedioConAplazos,
    porcentajeAvance,
    totalAprobadas: materiasAprobadas.length,
    materiasAprobadas,
    materiasRegulares
  };
}

export function normalizeMateria(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchMateriaFilter(matNombre: string, targetMateria: string): boolean {
  const normMat = normalizeMateria(matNombre);
  const normTarget = normalizeMateria(targetMateria);
  if (!normTarget) return true;
  if (normMat === normTarget) return true;

  const targetTokens = normTarget.split(" ").filter(Boolean);
  const matTokens = normMat.split(" ").filter(Boolean);

  // Cada palabra del filtro debe coincidir de forma completa (evita que 'I' matchee 'II' o 'III')
  return targetTokens.every((token) => matTokens.includes(token));
}

// Compara dos materias priorizando código exacto cuando ambos están presentes para evitar falsos positivos
export function matchMateria(
  codeA?: string,
  nameA?: string,
  codeB?: string,
  nameB?: string
): boolean {
  if (codeA && codeB) {
    return codeA.trim().toLowerCase() === codeB.trim().toLowerCase();
  }
  return matchMateriaFilter(nameA || "", nameB || "");
}

// Parser puro para mesas de examen disponibles
export function parseMesasExamen(html: string, targetMateria = ""): MesaExamenInfo[] {
  const $ = cheerio.load(html);
  const mesas: MesaExamenInfo[] = [];

  $(".mesa-examen, tr.mesa, .item-mesa").each((_, el) => {
    const matNombre = $(el).find(".materia, td.materia, h4").first().text().trim();
    if (targetMateria && !matchMateriaFilter(matNombre, targetMateria)) {
      return;
    }

    const rawFecha = $(el).find(".fecha, td.fecha").first().text().trim() || undefined;
    const rawHora = $(el).find(".hora, td.hora").first().text().trim() || undefined;
    const tribunal = $(el).find(".tribunal, td.tribunal").first().text().trim() || undefined;

    const cleanMateria = (matNombre || targetMateria).toLowerCase().replace(/[^a-z0-9]/g, "_");
    const cleanFecha = (rawFecha || "").replace(/[^0-9]/g, "");
    const fallbackId = `mesa_${cleanMateria}${cleanFecha ? `_${cleanFecha}` : ""}`;

    const llamadoId =
      $(el).attr("data-llamado") ||
      $(el).attr("data-mesa") ||
      $(el).find('input[name="llamado"], input[name="mesa"]').val()?.toString() ||
      fallbackId;

    const elTextLower = $(el).text().toLowerCase();
    let condicionPermitida: MesaExamenInfo["condicionPermitida"] = "No verificado";
    if (elTextLower.includes("condición: regular") || elTextLower.includes("condicion: regular")) {
      condicionPermitida = "Regular";
    } else if (elTextLower.includes("condición: libre") || elTextLower.includes("condicion: libre")) {
      condicionPermitida = "Libre";
    } else if (elTextLower.includes("libre y regular") || elTextLower.includes("ambas")) {
      condicionPermitida = "Ambas";
    }
    const inscripcionAbierta = !$(el).hasClass("cerrada") && !$(el).find(".cerrada, .inactiva").length;

    mesas.push({
      materia: matNombre || targetMateria,
      llamadoId,
      fecha: rawFecha,
      hora: rawHora,
      tribunal,
      condicionPermitida,
      inscripcionAbierta
    });
  });

  return mesas;
}

export async function readGuaraniText(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (utf8.includes("\uFFFD")) {
    try {
      const latin1 = new TextDecoder("windows-1252").decode(bytes);
      if (!latin1.includes("\uFFFD")) {
        return latin1;
      }
    } catch {}
  }
  return utf8;
}

// Extrae de forma confiable la carrera activa a partir del HTML de Guaraní
export function extractActiveCareerFromHtml(html: string): string | undefined {
  const $ = cheerio.load(html);

  // 1. Selector de carrera activa en barra superior / encabezado
  const activeSelector = $(
    "a.js-select-carreras.active, a.js-select-carreras.selected, li.active a.js-select-carreras, .carrera-activa, .js-carrera-activa, .carrera-actual, .propuesta-activa"
  ).first();
  const directText = activeSelector.text().replace(/\s+/g, " ").trim();
  if (directText && !NON_DEGREE_PATTERN.test(directText)) {
    return directText;
  }

  // 2. Elemento seleccionado en combo/select de propuestas o carreras
  const optionSelected = $("select[name='carrera'] option[selected], select[name='propuesta'] option[selected], #combo_carreras option[selected]").first();
  const optionText = optionSelected.text().replace(/\s+/g, " ").trim();
  if (optionText && !NON_DEGREE_PATTERN.test(optionText)) {
    return optionText;
  }

  // 3. Tarjeta de datos del alumno
  const datosCarrera = $(".datos-alumno .carrera, .datos-alumno .propuesta, .datos-propuesta").first().text().replace(/\s+/g, " ").trim();
  if (datosCarrera && !NON_DEGREE_PATTERN.test(datosCarrera)) {
    return datosCarrera;
  }

  return undefined;
}

function normalizeCareer(str: string): string {
  return str
    .toLowerCase()
    .replace(/\uFFFD+/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let carreraActivaVerificada: { nombre: string; checkedAt: number } | null = null;

export function clearCarreraActivaCache(): void {
  carreraActivaVerificada = null;
}
registerSessionPurgeHook(clearCarreraActivaCache);

// Descubre carreras disponibles en Guaraní, descarta cursos auxiliares y conmuta a la carrera académica objetivo
export async function ensureCarreraActiva(
  targetCarrera?: string,
  forceStrict = false
): Promise<{
  activa?: string;
  disponibles: string[];
}> {
  const session = loadEncryptedSession();
  let disponibles: Array<{ id: string; nombre: string }> = session?.carrerasDisponibles || [];
  if (disponibles.some((c) => c.nombre.includes("\uFFFD"))) {
    disponibles = [];
  }

  // Fast path para consultas de lectura si la carrera fue verificada recientemente (< 5 min)
  if (!forceStrict && carreraActivaVerificada && (Date.now() - carreraActivaVerificada.checkedAt < 5 * 60 * 1000)) {
    if (!targetCarrera) {
      return { activa: carreraActivaVerificada.nombre, disponibles: disponibles.map((c) => c.nombre) };
    }
    const normTarget = normalizeCareer(targetCarrera);
    const normActive = normalizeCareer(carreraActivaVerificada.nombre);
    if (normTarget === normActive || normActive.includes(normTarget)) {
      return { activa: carreraActivaVerificada.nombre, disponibles: disponibles.map((c) => c.nombre) };
    }
  }

  if (disponibles.length === 0) {
    try {
      const res = await guaraniFetch("/", {
        headers: { "X-Requested-With": "", "Accept": "text/html" }
      });
      const html = await readGuaraniText(res);
      const $ = cheerio.load(html);
      const all: Array<{ id: string; nombre: string }> = [];

      $("a.js-select-carreras").each((_, a) => {
        const id = $(a).attr("data-carrera-id");
        const nombre = $(a).text().replace(/\s+/g, " ").trim();
        if (id && nombre) all.push({ id, nombre });
      });

      const validas = all.filter((c) => !NON_DEGREE_PATTERN.test(c.nombre));
      disponibles = validas.length > 0 ? validas : all;

      const s = loadEncryptedSession();
      if (s) {
        s.carrerasDisponibles = disponibles;
        saveEncryptedSession(s);
      }
    } catch (err) {
      logger.warn(`No se pudieron descubrir las carreras en Guaraní: ${err}`);
    }
  }

  // 1. Si el usuario especificó una carrera (ID numérico o nombre)
  if (targetCarrera) {
    const normTarget = normalizeCareer(targetCarrera);
    const targetKeywords = normTarget.split(" ").filter((w) => w.length > 2);
    const match = disponibles.find((c) => {
      if (c.id === targetCarrera) return true;
      const normNombre = normalizeCareer(c.nombre);
      if (normNombre.includes(normTarget)) return true;
      if (targetKeywords.length > 0 && targetKeywords.every((kw) => normNombre.includes(kw))) return true;
      return false;
    });

    if (!match && disponibles.length > 0) {
      throw new Error(
        `La carrera '${targetCarrera}' no se encuentra entre las carreras matriculadas del alumno en Guaraní (${disponibles.map((c) => c.nombre).join(", ")}).`
      );
    }
    const targetId = match ? match.id : targetCarrera;
    const targetNombre = match ? match.nombre : targetCarrera;

    // Si ya está activa en la sesión, saltear conmutación y verificación para ahorrar 2 requests (salvo forceStrict)
    if (!forceStrict && session?.carreraActiva === targetNombre) {
      carreraActivaVerificada = { nombre: targetNombre, checkedAt: Date.now() };
      return { activa: targetNombre, disponibles: disponibles.map((c) => c.nombre) };
    }

    const changeRes = await guaraniFetch(`/acceso/cambiar_carrera?id=${encodeURIComponent(targetId)}&op=inicio_alumno`);
    if (!changeRes.ok) {
      throw new Error(`Error al conmutar a la carrera '${targetNombre}' en Guaraní (HTTP ${changeRes.status}).`);
    }

    // Verificación estricta del estado activo en el servidor para evitar inscribir en carrera equivocada
    const verifyRes = await guaraniFetch("/", {
      headers: { "X-Requested-With": "", "Accept": "text/html" }
    });
    const verifyHtml = await readGuaraniText(verifyRes);
    const activeFromHtml = extractActiveCareerFromHtml(verifyHtml);
    const $verify = cheerio.load(verifyHtml);
    const activeIdMatch =
      $verify(
        `a.js-select-carreras[data-carrera-id="${targetId}"].active, ` +
        `a.js-select-carreras[data-carrera-id="${targetId}"].selected, ` +
        `a.js-select-carreras[data-carrera-id="${targetId}"][data-carrera-selected="1"], ` +
        `li.active a.js-select-carreras[data-carrera-id="${targetId}"]`
      ).length > 0;

    let matchesActive = false;
    if (activeIdMatch) {
      matchesActive = true;
    } else if (activeFromHtml) {
      const normActive = normalizeCareer(activeFromHtml);
      const normTargetName = normalizeCareer(targetNombre);
      const targetKeywords = normTargetName.split(" ").filter((w) => w.length > 2);
      matchesActive =
        normActive.includes(normTargetName) ||
        (targetKeywords.length > 0 && targetKeywords.every((kw) => normActive.includes(kw)));
    }
    if (!matchesActive) {
      throw new Error(
        `Fallo al activar la carrera '${targetNombre}' en SIU Guaraní (el servidor no confirmó el cambio de carrera).`
      );
    }

    const s = loadEncryptedSession();
    if (s) {
      s.carreraActiva = targetNombre;
      saveEncryptedSession(s);
    }
    carreraActivaVerificada = { nombre: targetNombre, checkedAt: Date.now() };
    return { activa: targetNombre, disponibles: disponibles.map((c) => c.nombre) };
  }

  // 2. Si solo hay 1 carrera de grado/posgrado disponible, conmutar automáticamente para asegurar contexto en Guaraní
  if (disponibles.length === 1) {
    const unica = disponibles[0];
    if (!forceStrict && session?.carreraActiva === unica.nombre) {
      carreraActivaVerificada = { nombre: unica.nombre, checkedAt: Date.now() };
      return { activa: unica.nombre, disponibles: [unica.nombre] };
    }
    try {
      await guaraniFetch(`/acceso/cambiar_carrera?id=${encodeURIComponent(unica.id)}&op=inicio_alumno`);
      const s = loadEncryptedSession();
      if (s) {
        s.carreraActiva = unica.nombre;
        saveEncryptedSession(s);
      }
    } catch (err) {
      logger.warn(`Fallo al auto-conmutar a la carrera ${unica.nombre}: ${err}`);
    }
    carreraActivaVerificada = { nombre: unica.nombre, checkedAt: Date.now() };
    return { activa: unica.nombre, disponibles: [unica.nombre] };
  }

  // 3. Múltiples carreras: leer la carrera activa real en el servidor para no etiquetar erróneamente
  let realActiva: string | undefined;
  try {
    const checkRes = await guaraniFetch("/", {
      headers: { "X-Requested-With": "", "Accept": "text/html" }
    });
    const checkHtml = await readGuaraniText(checkRes);
    realActiva = extractActiveCareerFromHtml(checkHtml);
  } catch {}

  const activa = realActiva || session?.carreraActiva || disponibles[0]?.nombre;
  if (realActiva) {
    const s = loadEncryptedSession();
    if (s && s.carreraActiva !== realActiva) {
      s.carreraActiva = realActiva;
      saveEncryptedSession(s);
    }
  }
  if (activa) {
    carreraActivaVerificada = { nombre: activa, checkedAt: Date.now() };
  }
  return { activa, disponibles: disponibles.map((c) => c.nombre) };
}

const GUARANI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos de caché en memoria
const cursadaCache = new Map<string, { data: CursadaInfo[]; expires: number }>();
const historiaCache = new Map<string, { data: HistoriaAcademicaInfo; expires: number }>();

export function clearGuaraniCache(): void {
  cursadaCache.clear();
  historiaCache.clear();
}
registerSessionPurgeHook(clearGuaraniCache);

// 1. Obtener estado de cursadas activas e inasistencias acumuladas
export async function getEstadoCursada(carrera?: string, forzarRefresco = false): Promise<CursadaInfo[]> {
  const cacheKey = (carrera || "default").toLowerCase();
  if (!forzarRefresco) {
    const cached = cursadaCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }
  }

  return withGuaraniLock(async () => {
    try {
      await ensureCarreraActiva(carrera);

      // 1. Obtener inasistencias y cursadas en paralelo
      const [inasResResult, calResResult] = await Promise.allSettled([
        guaraniFetch("/reporte_inasistencias"),
        guaraniFetch("/calendario")
      ]);

      let inasistenciasList: InasistenciasMateriaParsed[] = [];
      if (inasResResult.status === "fulfilled") {
        try {
          const inasRaw = await readGuaraniText(inasResResult.value);
          inasistenciasList = parseReporteInasistencias(unwrapChulupiHtml(inasRaw));
        } catch (err) {
          logger.warn(`No se pudo parsear /reporte_inasistencias: ${err}`);
        }
      } else {
        logger.warn(`No se pudo obtener /reporte_inasistencias: ${inasResResult.reason}`);
      }

      let cursadas: CursadaInfo[] = [];
      if (calResResult.status === "fulfilled") {
        try {
          const calRaw = await readGuaraniText(calResResult.value);
          cursadas = parseCalendarioAsignaciones(calRaw);
        } catch (err) {
          logger.warn(`No se pudo parsear /calendario: ${err}`);
        }
      } else {
        logger.warn(`No se pudo obtener /calendario: ${calResResult.reason}`);
      }

      // 3. Fallback a /cursada si /calendario vino vacío
      if (cursadas.length === 0) {
        try {
          const curRes = await guaraniFetch("/cursada");
          const curRaw = await readGuaraniText(curRes);
          cursadas = parseCursadas(unwrapChulupiHtml(curRaw));
        } catch {}
      }

      // 4. Si aún está vacío pero tenemos materias en reporte de inasistencias, agregarlas
      if (cursadas.length === 0 && inasistenciasList.length > 0) {
        for (const inas of inasistenciasList) {
          cursadas.push({
            materia: inas.materia,
            codigo: inas.codigo,
            comision: inas.comision,
            condicion: "Cursando"
          });
        }
      }

      // 5. Cruzar cursadas con inasistencias y aplicar el cálculo de faltas
      for (const cur of cursadas) {
        const match = inasistenciasList.find((ina) =>
          matchMateria(cur.codigo, cur.materia, ina.codigo, ina.materia)
        );

        if (match) {
          cur.asistencia = `${match.porcentajeAsistencia}%`;
          cur.inasistencias = match.inasistenciasTotales;
          cur.detalleInasistencias = match.detalles;
          cur.calculoFaltas = calcularFaltas(match.porcentajeAsistencia, match.inasistenciasTotales);
        } else {
          // Si no figura en el reporte de inasistencias, tiene 0 faltas (100% de asistencia)
          cur.asistencia = "100%";
          cur.inasistencias = 0;
          cur.detalleInasistencias = [];
          cur.calculoFaltas = calcularFaltas(100, 0);
        }
      }

      // 6. Asegurar que cualquier materia con inasistencias que no estaba en /calendario esté incluida
      for (const inas of inasistenciasList) {
        const already = cursadas.some((c) =>
          matchMateria(c.codigo, c.materia, inas.codigo, inas.materia)
        );
        if (!already) {
          cursadas.push({
            materia: inas.materia,
            codigo: inas.codigo,
            comision: inas.comision,
            condicion: "Cursando",
            asistencia: `${inas.porcentajeAsistencia}%`,
            inasistencias: inas.inasistenciasTotales,
            detalleInasistencias: inas.detalles,
            calculoFaltas: calcularFaltas(inas.porcentajeAsistencia, inas.inasistenciasTotales)
          });
        }
      }

      cursadaCache.set(cacheKey, { data: cursadas, expires: Date.now() + GUARANI_CACHE_TTL_MS });
      return cursadas;
    } catch (err) {
      logger.error("Error al obtener estado de cursada en Guaraní", err);
      throw err;
    }
  });
}

// 2. Obtener historia académica completa y analítico
export async function getHistoriaAcademica(carrera?: string, forzarRefresco = false): Promise<HistoriaAcademicaInfo> {
  const cacheKey = (carrera || "default").toLowerCase();
  if (!forzarRefresco) {
    const cached = historiaCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }
  }

  return withGuaraniLock(async () => {
    try {
      const { activa, disponibles } = await ensureCarreraActiva(carrera);

      // Lanzar historia académica y porcentaje de avance en paralelo
      const [histResResult, avanceResResult] = await Promise.allSettled([
        guaraniFetch("/historia_academica"),
        guaraniFetch("/porcentaje_avance_carrera")
      ]);

      if (histResResult.status === "rejected") {
        throw histResResult.reason;
      }

      const rawText = await readGuaraniText(histResResult.value);
      const html = unwrapChulupiHtml(rawText);

      const parsed = parseHistoriaAcademica(html, {
        carreraActiva: activa,
        carrerasDisponibles: disponibles.length > 1 ? disponibles : undefined
      });

      // Si no encontró promedios o avance en la vista principal, enriquecer con la respuesta de /porcentaje_avance_carrera
      if (
        (parsed.promedioSinAplazos === undefined || parsed.porcentajeAvance === undefined) &&
        avanceResResult.status === "fulfilled"
      ) {
        try {
          const avanceRaw = await readGuaraniText(avanceResResult.value);
          let avanceHtml = unwrapChulupiHtml(avanceRaw);

          const match = avanceHtml.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);/);
          if (match) {
            try {
              const arrival = JSON.parse(match[1]);
              if (arrival.content) avanceHtml = arrival.content;
            } catch {}
          }

          const $avance = cheerio.load(avanceHtml);
          const textSummary = $avance.text().replace(/\s+/g, " ");

          const sinAplazosMatch = /sin\s+aplazos?[:\s]+([\d.,]+)/i.exec(textSummary);
          const conAplazosMatch = /con\s+aplazos?[:\s]+([\d.,]+)/i.exec(textSummary);
          const avanceMatch =
            /(?:porcentaje|avance)[\s\w]*?[:\s]+([\d.,]+)\s*%/i.exec(textSummary) ||
            /([\d.,]+)\s*%\s*(?:de avance|completado|aprobado)/i.exec(textSummary);

          if (parsed.promedioSinAplazos === undefined && sinAplazosMatch) {
            parsed.promedioSinAplazos = parseFloat(sinAplazosMatch[1].replace(",", "."));
          }
          if (parsed.promedioConAplazos === undefined && conAplazosMatch) {
            parsed.promedioConAplazos = parseFloat(conAplazosMatch[1].replace(",", "."));
          }
          if (parsed.porcentajeAvance === undefined && avanceMatch) {
            parsed.porcentajeAvance = parseFloat(avanceMatch[1].replace(",", "."));
          }
        } catch (err) {
          logger.warn(`No se pudo consultar /porcentaje_avance_carrera: ${err}`);
        }
      }

      historiaCache.set(cacheKey, { data: parsed, expires: Date.now() + GUARANI_CACHE_TTL_MS });
      return parsed;
    } catch (err) {
      logger.error("Error al obtener historia académica en Guaraní", err);
      throw err;
    }
  });
}

// 3. Obtener mesas de examen final disponibles para una materia
export async function getMesasDisponibles(carrera: string, materia: string): Promise<MesaExamenInfo[]> {
  return withGuaraniLock(async () => {
    try {
      await ensureCarreraActiva(carrera);
      const res = await guaraniFetch(`/inscripcion_examen`);
      const rawText = await readGuaraniText(res);
      return parseMesasExamen(unwrapChulupiHtml(rawText), materia);
    } catch (err) {
      logger.error("Error al obtener mesas disponibles en Guaraní", err);
      throw err;
    }
  });
}

// Parser puro para plan de estudios de SIU Guaraní
export function parsePlanEstudio(html: string): PlanEstudiosInfo {
  const $ = cheerio.load(html);
  const materias: MateriaPlan[] = [];

  const encabezadoCells = $("table.encabezado td, .encabezado td");
  const propuesta = encabezadoCells.eq(0).text().replace(/^Propuesta:\s*/i, "").trim() || undefined;
  const plan = encabezadoCells.eq(1).text().replace(/^Plan:\s*/i, "").trim() || undefined;
  const version = encabezadoCells.eq(2).text().replace(/^Versi[oó]n:\s*/i, "").trim() || undefined;

  const accGroups = $(".accordion-group").length > 0 ? $(".accordion-group") : $(".modulos.accordion, .accordion");
  accGroups.each((_, acc) => {
    const toggleText = $(acc).find(".accordion-toggle").first().text().replace(/\s+/g, " ").trim();
    const anioMatch = /(\d+)°\s*A[nñ]o/i.exec(toggleText);
    const defaultAnio = anioMatch ? parseInt(anioMatch[1], 10) : 1;

    $(acc).find("tr.materia").each((__, tr) => {
      const cells = $(tr).find("td").map((___, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
      if (cells.length < 5) return;

      const rawActividad = cells[0];
      const codMatch = /\(([A-Z0-9]+)\)/i.exec(rawActividad);
      const codigo = codMatch ? codMatch[1] : "";
      const nombre = rawActividad.replace(/\([A-Z0-9]+\)/i, "").trim();

      if (materias.some((m) => (codigo ? m.codigo === codigo : m.nombre === nombre))) {
        return;
      }

      const tipo = cells[1] || "Materia";
      const anioCell = parseInt(cells[2], 10);
      const anio = !isNaN(anioCell) ? anioCell : defaultAnio;
      const periodo = cells[3] || "";
      const rawNota = cells[4] || "";
      const origen = cells[5] || undefined;
      const creditos = cells[6] || undefined;
      const puntaje = cells[7] || undefined;

      const corrLink = $(tr).find("a.ver_correlatividades").first();
      const elementoId = corrLink.attr("data-elemento") || undefined;
      const elementoPadreId = corrLink.attr("data-elemento-padre") || corrLink.attr("data-elementoPadre") || undefined;

      let estado: MateriaPlan["estado"] = "Pendiente";
      const rawNotaLower = rawNota.toLowerCase();
      if (rawNotaLower.includes("promocion") || (origen && origen.toLowerCase().includes("promoci"))) {
        estado = "Promocionada";
      } else if (!rawNotaLower.includes("desaprob") && (rawNotaLower.includes("aprobad") || rawNotaLower.includes("aprob"))) {
        estado = "Aprobada";
      } else if (rawNotaLower.includes("regular")) {
        estado = "Regularizada";
      }

      materias.push({
        nombre,
        codigo,
        anio,
        periodo,
        tipo,
        estado,
        nota: rawNota || undefined,
        origen,
        creditos,
        puntaje,
        elementoId,
        elementoPadreId
      });
    });
  });

  return {
    propuesta,
    plan,
    version,
    materias
  };
}

// Parser puro para tabla de correlativas de una materia
export function parseCorrelativasHtml(html: string): {
  paraCursar: CorrelativaRequisito[];
  paraAprobar: CorrelativaRequisito[];
} {
  const $ = cheerio.load(html);
  const paraCursar: CorrelativaRequisito[] = [];
  const paraAprobar: CorrelativaRequisito[] = [];

  // 1. Correlativas para cursar
  $("table[summary*='cursar'], table[summary*='Cursar']").each((_, tbl) => {
    $(tbl).find("tr").each((__, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 2) return;
      const rawMat = tds.eq(0).text().replace(/\s+/g, " ").trim();
      const rawCond = tds.eq(1).text().replace(/\s+/g, " ").trim();
      if (!rawMat) return;

      const codMatch = /\(([A-Z0-9]+)\)/i.exec(rawMat);
      const codigo = codMatch ? codMatch[1] : undefined;
      const materia = rawMat.replace(/\([A-Z0-9]+\)/i, "").trim();
      const condicionRequerida: "Regularizada" | "Aprobada" =
        rawCond.toLowerCase().includes("aprob") ? "Aprobada" : "Regularizada";

      paraCursar.push({
        materia,
        codigo,
        condicionRequerida
      });
    });
  });

  // 2. Correlativas para aprobar
  $("table[summary*='aprobar'], table[summary*='Aprobar']").each((_, tbl) => {
    $(tbl).find("tr").each((__, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 2) return;
      const rawMat = tds.eq(0).text().replace(/\s+/g, " ").trim();
      const rawCond = tds.eq(1).text().replace(/\s+/g, " ").trim();
      if (!rawMat) return;

      const codMatch = /\(([A-Z0-9]+)\)/i.exec(rawMat);
      const codigo = codMatch ? codMatch[1] : undefined;
      const materia = rawMat.replace(/\([A-Z0-9]+\)/i, "").trim();
      const condicionRequerida: "Regularizada" | "Aprobada" =
        rawCond.toLowerCase().includes("regular") ? "Regularizada" : "Aprobada";

      paraAprobar.push({
        materia,
        codigo,
        condicionRequerida
      });
    });
  });

  return { paraCursar, paraAprobar };
}

// Filtra materias que cronológicamente pueden depender de la materia objetivo sin omitir correlativas válidas
export function isPotentialDependent(cand: MateriaPlan, target: MateriaPlan): boolean {
  if (cand.codigo === target.codigo || !cand.elementoId || !cand.elementoPadreId) return false;
  // Años posteriores: siempre candidata (1 año, 1.5 años, 2 años, etc.)
  if (cand.anio > target.anio) return true;
  // Mismo año: solo si la materia objetivo es de 1er semestre y la candidata es de 2do semestre o anual
  if (cand.anio === target.anio) {
    const tPer = (target.periodo || "").toLowerCase();
    const cPer = (cand.periodo || "").toLowerCase();
    const targetIs1st = tPer.includes("1") || tPer.includes("primer");
    const candIsLater = cPer.includes("2") || cPer.includes("segund") || cPer.includes("anual");
    return targetIs1st && candIsLater;
  }
  return false;
}

function getPlanCachePath(propuesta?: string, plan?: string, version?: string): string {
  const rawKey = `${propuesta || "prop"}_${plan || "plan"}_${version || "v1"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CONFIG.CACHE_DIR, `correlativas_${rawKey}.json`);
}

function loadPlanCorrelativasCache(
  cachePath: string
): Record<string, { paraCursar: CorrelativaRequisito[]; paraAprobar: CorrelativaRequisito[] }> {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    }
  } catch {}
  return {};
}

function savePlanCorrelativasCache(cachePath: string, cache: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(CONFIG.CACHE_DIR)) {
      fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {}
}

export interface GraphJob {
  promise: Promise<void>;
  done: boolean;
  total: number;
  fetched: number;
  failed: string[];
}

const inMemoryGraphs = new Map<string, Record<string, { paraCursar: CorrelativaRequisito[]; paraAprobar: CorrelativaRequisito[] }>>();
const inFlightJobs = new Map<string, GraphJob>();

function getGraph(cachePath: string): Record<string, { paraCursar: CorrelativaRequisito[]; paraAprobar: CorrelativaRequisito[] }> {
  let graph = inMemoryGraphs.get(cachePath);
  if (!graph) {
    graph = loadPlanCorrelativasCache(cachePath);
    inMemoryGraphs.set(cachePath, graph);
  }
  return graph;
}

export function clearGuaraniGraphCache(): void {
  inMemoryGraphs.clear();
  inFlightJobs.clear();
}
registerSessionPurgeHook(clearGuaraniGraphCache);

function rankMateria(m: MateriaPlan, priorityIds: string[], targetAnio?: number): number {
  if (m.elementoId && priorityIds.includes(m.elementoId)) return -100;
  if (targetAnio !== undefined) {
    const diff = m.anio - targetAnio;
    if (diff > 0) return diff;
    return 10 + Math.abs(diff);
  }
  return m.anio;
}

// Inicia o suscribe a la descarga en segundo plano del grafo completo de correlativas sin cortar por tope
export function startGraphJob(
  planInfo: PlanEstudiosInfo,
  cachePath: string,
  priorityIds: string[] = [],
  targetAnio?: number
): GraphJob {
  const existing = inFlightJobs.get(cachePath);
  if (existing && !existing.done) {
    return existing;
  }

  const graph = getGraph(cachePath);
  const missing = planInfo.materias
    .filter((m) => m.elementoId && m.elementoPadreId && !graph[m.elementoId])
    .sort((a, b) => {
      const rankA = rankMateria(a, priorityIds, targetAnio);
      const rankB = rankMateria(b, priorityIds, targetAnio);
      if (rankA !== rankB) return rankA - rankB;
      return a.anio - b.anio;
    });

  if (missing.length === 0) {
    return {
      promise: Promise.resolve(),
      done: true,
      total: 0,
      fetched: 0,
      failed: []
    };
  }

  const job: GraphJob = {
    promise: Promise.resolve(),
    done: false,
    total: missing.length,
    fetched: 0,
    failed: []
  };

  job.promise = (async () => {
    let qIdx = 0;
    let dirty = false;
    // Menor concurrencia (2 en vez de 4) para no acaparar los 4 slots de httpLimiter frente a consultas del usuario
    const CONCURRENCY = 2;
    const workers = Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
      while (qIdx < missing.length) {
        const m = missing[qIdx++];
        try {
          const body = new URLSearchParams({
            elemento: m.elementoId!,
            elemento_padre: m.elementoPadreId!
          });
          const corrRes = await guaraniFetch("/plan_estudio/correlativas", {
            method: "POST",
            body,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            priority: "low"
          });
          const corrHtml = unwrapChulupiHtml(await readGuaraniText(corrRes));
          const parsed = parseCorrelativasHtml(corrHtml);
          graph[m.elementoId!] = parsed;
          job.fetched++;
          dirty = true;
        } catch {
          job.failed.push(m.nombre);
        }
      }
    });

    await Promise.all(workers);
    if (dirty) {
      savePlanCorrelativasCache(cachePath, graph);
    }
    job.done = true;
    inFlightJobs.delete(cachePath);
  })();

  inFlightJobs.set(cachePath, job);
  return job;
}

// Pre-calienta proactivamente el plan de estudios y el grafo de correlatividades sin retener el cerrojo global
export async function prefetchPlanGraph(carrera?: string): Promise<void> {
  const session = loadEncryptedSession();
  if (!session?.siuSession && !session?.cookies) return;

  try {
    const planInfo = await withGuaraniLock(async () => {
      await ensureCarreraActiva(carrera);
      const res = await guaraniFetch("/plan_estudio");
      const rawText = await readGuaraniText(res);
      return parsePlanEstudio(unwrapChulupiHtml(rawText));
    });

    const cachePath = getPlanCachePath(planInfo.propuesta, planInfo.plan, planInfo.version);
    const job = startGraphJob(planInfo, cachePath);
    await job.promise;
    logger.info(`Grafo de correlatividades pre-calentado con éxito para ${planInfo.propuesta || "carrera activa"}.`);
  } catch (err) {
    logger.warn(`No se pudo pre-calentar el grafo de correlatividades: ${err}`);
  }
}

// 4. Obtener plan de estudio interactivo y análisis de correlatividades / impacto
export async function getPlanEstudio(
  carrera?: string,
  targetMateria?: string
): Promise<PlanEstudiosInfo> {
  const planInfo = await withGuaraniLock(async () => {
    try {
      await ensureCarreraActiva(carrera);

      // Lanzar plan de estudio y calendario en paralelo
      const [planResResult, calResResult] = await Promise.allSettled([
        guaraniFetch("/plan_estudio"),
        guaraniFetch("/calendario")
      ]);

      if (planResResult.status === "rejected") {
        throw planResResult.reason;
      }

      const rawText = await readGuaraniText(planResResult.value);
      const parsed = parsePlanEstudio(unwrapChulupiHtml(rawText));

      // Sincronizar estados de materias cursando actualmente
      try {
        let cursadas: CursadaInfo[] = [];
        if (calResResult.status === "fulfilled") {
          try {
            const calRaw = await readGuaraniText(calResResult.value);
            cursadas = parseCalendarioAsignaciones(calRaw);
          } catch {}
        }
        if (cursadas.length === 0) {
          const cursadasRes = await guaraniFetch("/cursada");
          const cursadasHtml = unwrapChulupiHtml(await readGuaraniText(cursadasRes));
          cursadas = parseCursadas(cursadasHtml);
        }
        for (const c of cursadas) {
          const match = parsed.materias.find((m) =>
            matchMateria(c.codigo, c.materia, m.codigo, m.nombre)
          );
          if (match && match.estado === "Pendiente") {
            match.estado = "Cursando";
          }
        }
      } catch {}

      return parsed;
    } catch (err) {
      logger.error("Error al obtener plan de estudio en Guaraní", err);
      throw err;
    }
  });

  const cachePath = getPlanCachePath(planInfo.propuesta, planInfo.plan, planInfo.version);

  let mat: MateriaPlan | undefined;
  let priorityIds: string[] = [];
  let targetAnio: number | undefined;

  if (targetMateria) {
    const normTarget = normalizeMateria(targetMateria);
    mat =
      planInfo.materias.find(
        (m) => normalizeMateria(m.nombre) === normTarget || m.codigo.toLowerCase() === normTarget.toLowerCase()
      ) ||
      planInfo.materias.find((m) => matchMateriaFilter(m.nombre, targetMateria));
    if (mat) {
      priorityIds = [mat.elementoId].filter(Boolean) as string[];
      targetAnio = mat.anio;
    }
  }

  const job = startGraphJob(planInfo, cachePath, priorityIds, targetAnio);

  // Esperar hasta 3.5s por el pool de correlativas para no bloquear la respuesta en clientes MCP
  await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, 3500))]);

  const graph = getGraph(cachePath);

  // Calcular qué materias pendientes se encuentran habilitadas para cursar el próximo período
  let materiasSinVerificar = 0;
  planInfo.materiasHabilitadasParaCursar = planInfo.materias.filter((m) => {
    if (m.estado !== "Pendiente") return false;
    const corr = m.elementoId ? graph[m.elementoId] : null;
    if (!corr) {
      materiasSinVerificar++;
      return false;
    }
    if (!corr.paraCursar || corr.paraCursar.length === 0) {
      return true;
    }
    return corr.paraCursar.every((req) => {
      const reqMat = planInfo.materias.find((p) =>
        matchMateria(req.codigo, req.materia, p.codigo, p.nombre)
      );
      if (!reqMat) return false;
      if (req.condicionRequerida === "Regularizada") {
        return reqMat.estado === "Regularizada" || reqMat.estado === "Aprobada" || reqMat.estado === "Promocionada";
      }
      return reqMat.estado === "Aprobada" || reqMat.estado === "Promocionada";
    });
  });

  if (!targetMateria || !mat) {
    if (targetMateria && !mat) {
      planInfo.resumenImpacto = `No se encontró la materia '${targetMateria}' en el plan de estudios de ${planInfo.propuesta || "la carrera"}.`;
    }
    planInfo.analisisCompleto = materiasSinVerificar === 0 && job.failed.length === 0;
    planInfo.materiasSinVerificar = materiasSinVerificar;
    return planInfo;
  }

  // 1. Correlativas de la materia consultada
  if (mat.elementoId && graph[mat.elementoId]) {
    const { paraCursar, paraAprobar } = graph[mat.elementoId];

    mat.correlativasParaCursar = paraCursar.map((req) => {
      const reqMat = planInfo.materias.find((m) =>
        matchMateria(req.codigo, req.materia, m.codigo, m.nombre)
      );
      const estadoActual = reqMat ? reqMat.estado : "Pendiente";
      const cumple =
        req.condicionRequerida === "Regularizada"
          ? estadoActual === "Regularizada" || estadoActual === "Aprobada" || estadoActual === "Promocionada"
          : estadoActual === "Aprobada" || estadoActual === "Promocionada";
      return { ...req, estadoActual, cumple };
    });

    mat.correlativasParaAprobar = paraAprobar.map((req) => {
      const reqMat = planInfo.materias.find((m) =>
        matchMateria(req.codigo, req.materia, m.codigo, m.nombre)
      );
      const estadoActual = reqMat ? reqMat.estado : "Pendiente";
      const cumple = estadoActual === "Aprobada" || estadoActual === "Promocionada";
      return { ...req, estadoActual, cumple };
    });
  } else {
    mat.correlativasParaCursar = [];
    mat.correlativasParaAprobar = [];
  }

  // 2. Análisis de impacto a futuro: descubrir qué materias posteriores dependen de esta
  const materiasDependientes: NonNullable<MateriaPlan["materiasQueDependenDeEsta"]> = [];
  const candidatasFuturas = planInfo.materias.filter((m) => isPotentialDependent(m, mat));
  materiasSinVerificar = candidatasFuturas.filter((c) => !graph[c.elementoId!]).length;
  const analisisCompleto = materiasSinVerificar === 0 && job.failed.length === 0;

  for (const fut of candidatasFuturas) {
    const fCorr = graph[fut.elementoId!];
    if (!fCorr) continue;

    const requiereCursar = fCorr.paraCursar.some((r) =>
      matchMateria(r.codigo, r.materia, mat.codigo, mat.nombre)
    );
    const requiereAprobar = fCorr.paraAprobar.some((r) =>
      matchMateria(r.codigo, r.materia, mat.codigo, mat.nombre)
    );

    if (requiereCursar) {
      if (!materiasDependientes.some((d) => d.codigo === fut.codigo && d.requierePara === "Cursar")) {
        materiasDependientes.push({
          materia: fut.nombre,
          codigo: fut.codigo,
          anio: fut.anio,
          requierePara: "Cursar"
        });
      }
    } else if (requiereAprobar) {
      if (!materiasDependientes.some((d) => d.codigo === fut.codigo && d.requierePara === "Aprobar")) {
        materiasDependientes.push({
          materia: fut.nombre,
          codigo: fut.codigo,
          anio: fut.anio,
          requierePara: "Aprobar"
        });
      }
    }
  }

  mat.materiasQueDependenDeEsta = materiasDependientes;
  planInfo.analisisMateria = mat;
  planInfo.analisisCompleto = analisisCompleto;
  planInfo.materiasSinVerificar = materiasSinVerificar;

  // Construir resumen de impacto en lenguaje natural
  const cursarOk =
    !mat.correlativasParaCursar ||
    mat.correlativasParaCursar.length === 0 ||
    mat.correlativasParaCursar.every((r) => r.cumple);
  const aprobarOk =
    !mat.correlativasParaAprobar ||
    mat.correlativasParaAprobar.length === 0 ||
    mat.correlativasParaAprobar.every((r) => r.cumple);

  const lines: string[] = [];
  lines.push(`Materia: ${mat.nombre} (${mat.codigo}) - Estado actual: ${mat.estado}`);
  if (mat.correlativasParaCursar && mat.correlativasParaCursar.length > 0) {
    lines.push(
      `Requisitos para CURSAR (${cursarOk ? "HABILITADO" : "TRABADO"}): ` +
        mat.correlativasParaCursar
          .map((r) => `${r.materia} (${r.condicionRequerida}) [${r.cumple ? "CUMPLE" : "ADEUDA"}]`)
          .join(", ")
    );
  } else {
    lines.push("Requisitos para CURSAR: Ninguno (sin correlativas previas).");
  }

  if (mat.correlativasParaAprobar && mat.correlativasParaAprobar.length > 0) {
    lines.push(
      `Requisitos para APROBAR FINAL (${aprobarOk ? "HABILITADO" : "TRABADO"}): ` +
        mat.correlativasParaAprobar
          .map((r) => `${r.materia} (${r.condicionRequerida}) [${r.cumple ? "CUMPLE" : "ADEUDA"}]`)
          .join(", ")
    );
  } else {
    lines.push("Requisitos para APROBAR FINAL: Ninguno (sin correlativas previas).");
  }

  const verificadas = candidatasFuturas.length - materiasSinVerificar;
  if (materiasDependientes.length > 0) {
    const dependientesStr = materiasDependientes
      .map((d) => `${d.materia} (${d.codigo}, ${d.anio}° Año - para ${d.requierePara})`)
      .join(", ");
    if (analisisCompleto) {
      lines.push(`Impacto a futuro (materias que trabaría si no se aprueba): ${dependientesStr}`);
    } else {
      lines.push(
        `Impacto a futuro (análisis preliminar: ${verificadas}/${candidatasFuturas.length} materias verificadas): ${dependientesStr}\n` +
          `⚠️ [Análisis preliminar]: Quedan ${materiasSinVerificar} materias posteriores en proceso de verificación en segundo plano. Reintentá en unos segundos para el resultado definitivo.`
      );
    }
  } else {
    if (analisisCompleto) {
      lines.push("Impacto a futuro: No es correlativa directa de materias posteriores del plan.");
    } else {
      lines.push(
        `Impacto a futuro: No se identificaron materias dependientes en las ${verificadas} materias verificadas hasta el momento.\n` +
          `⚠️ [Análisis preliminar]: Quedan ${materiasSinVerificar} materias posteriores en proceso de verificación en segundo plano. Reintentá en unos segundos para confirmar si alguna depende de esta.`
      );
    }
  }

  planInfo.resumenImpacto = lines.join("\n");
  return planInfo;
}

export interface MisInscripcionesResult {
  inscripciones: MesaExamenInfo[];
  mensaje: string;
}

// 5. Consultar inscripciones activas a mesas de examen final (en /actuacion_provisoria o /inscripcion_examen)
export async function getMisInscripcionesExamen(carrera?: string): Promise<MisInscripcionesResult> {
  return withGuaraniLock(async () => {
    await ensureCarreraActiva(carrera);

    const inscripciones: MesaExamenInfo[] = [];

    // 1. Consultar /actuacion_provisoria (página oficial de exámenes y promociones en curso)
    try {
      const provRes = await guaraniFetch("/actuacion_provisoria");
      const provRaw = await readGuaraniText(provRes);
      const provHtml = unwrapChulupiHtml(provRaw);

      if (!provHtml.includes("No hay información sobre actuaciones provisorias en exámenes") && !provHtml.includes("No hay informaci\\u00f3n")) {
        const parsed = parseMesasExamen(provHtml);
        inscripciones.push(...parsed);
      }
    } catch {}

    // 2. Si la inscripción a examen está abierta, consultar también /inscripcion_examen
    try {
      const insRes = await guaraniFetch("/inscripcion_examen");
      const insRaw = await readGuaraniText(insRes);
      const insHtml = unwrapChulupiHtml(insRaw);
      if (!insRaw.includes('"cod":"-2"') && !insHtml.includes("No hay llamados")) {
        const $ = cheerio.load(insHtml);
        $(".mesa-inscripta, tr.inscripto, .item-inscripto").each((_, el) => {
          const matNombre = $(el).find(".materia, td.materia, h4").first().text().trim();
          const rawFecha = $(el).find(".fecha, td.fecha").first().text().trim() || undefined;
          const rawHora = $(el).find(".hora, td.hora").first().text().trim() || undefined;
          const tribunal = $(el).find(".tribunal, td.tribunal").first().text().trim() || undefined;
          if (matNombre && !inscripciones.some((i) => i.materia === matNombre)) {
            inscripciones.push({
              materia: matNombre,
              llamadoId: $(el).attr("data-llamado") || `inscripta_${matNombre}`,
              fecha: rawFecha,
              hora: rawHora,
              tribunal,
              inscripcionAbierta: true,
              condicionPermitida: "Regular"
            });
          }
        });
      }
    } catch {}

    const mensaje =
      inscripciones.length > 0
        ? `Se encontraron ${inscripciones.length} inscripción(es) a examen final en SIU Guaraní.`
        : "No registrás inscripciones activas a mesas de examen final en SIU Guaraní.";

    return { inscripciones, mensaje };
  });
}

export interface EncuestaPendienteItem {
  titulo: string;
  materia?: string;
  url?: string;
}

export interface EncuestasPendientesResult {
  hayPendientes: boolean;
  encuestas: EncuestaPendienteItem[];
  mensaje: string;
}

// 6. Consultar encuestas docentes pendientes en SIU Guaraní (desde el pagelet institucional de /inicio_alumno)
export async function getEncuestasPendientes(carrera?: string): Promise<EncuestasPendientesResult> {
  return withGuaraniLock(async () => {
    await ensureCarreraActiva(carrera);

    const res = await guaraniFetch("/inicio_alumno");
    const raw = await readGuaraniText(res);

    let encuestasContent = "";
    const match = raw.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);/g);
    if (match) {
      for (const m of match) {
        if (m.includes("lista_encuestas_pendientes")) {
          try {
            const jsonStr = m.replace(/^kernel\.renderer\.on_arrival\(/, "").replace(/\);$/, "");
            const parsed = JSON.parse(jsonStr);
            if (parsed.content) encuestasContent = parsed.content;
          } catch {}
        }
      }
    }

    if (!encuestasContent) {
      encuestasContent = unwrapChulupiHtml(raw);
    }

    const $ = cheerio.load(encuestasContent);
    const encuestas: EncuestaPendienteItem[] = [];

    $("a[href*='encuesta'], li.encuesta, .item-encuesta").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const href = $(el).attr("href");
      if (text && !text.includes("No hay encuestas")) {
        encuestas.push({
          titulo: text,
          url: href ? new URL(href, CONFIG.GUARANI_BASE_URL).href : undefined
        });
      }
    });

    const hayPendientes = encuestas.length > 0;
    const mensaje = hayPendientes
      ? `Tenés ${encuestas.length} encuesta(s) docente(s) pendiente(s) por responder en SIU Guaraní.`
      : "No hay encuestas pendientes para completar en SIU Guaraní.";

    return {
      hayPendientes,
      encuestas,
      mensaje
    };
  });
}

export interface ProgresoCarreraInfo {
  carrera?: string;
  plan?: string;
  totalMaterias: number;
  aprobadas: number;
  faltantesParaRecibirse: number;
  cursando: number;
  regularizadas: number;
  porcentajeAvance?: number;
  materiasEnCurso: string[];
  materiasRestantesPorAnio: Record<number, string[]>;
  mensaje: string;
}

// 7. Calcular cuántas materias faltan para recibirse y el desglose de avance de carrera en SIU Guaraní
export async function getProgresoCarrera(carrera?: string): Promise<ProgresoCarreraInfo> {
  const planInfo = await getPlanEstudio(carrera);
  const totalMaterias = planInfo.materias.length;

  const aprobadasList = planInfo.materias.filter((m) => m.estado === "Aprobada" || m.estado === "Promocionada");
  const cursandoList = planInfo.materias.filter((m) => m.estado === "Cursando");
  const regularizadasList = planInfo.materias.filter((m) => m.estado === "Regularizada");
  const restantesList = planInfo.materias.filter((m) => m.estado !== "Aprobada" && m.estado !== "Promocionada");

  const materiasRestantesPorAnio: Record<number, string[]> = {};
  for (const m of restantesList) {
    if (!materiasRestantesPorAnio[m.anio]) {
      materiasRestantesPorAnio[m.anio] = [];
    }
    const estadoExtra = m.estado === "Cursando" ? " (Cursando)" : m.estado === "Regularizada" ? " (Regularizada)" : "";
    materiasRestantesPorAnio[m.anio].push(`${m.nombre} [${m.codigo}]${estadoExtra}`);
  }

  const porcentaje = totalMaterias > 0 ? Math.round((aprobadasList.length / totalMaterias) * 1000) / 10 : 0;
  const carreraNom = planInfo.propuesta || carrera || "tu carrera";
  const mensaje = `Te faltan ${restantesList.length} materias para recibirte (tenés ${aprobadasList.length} aprobadas de ${totalMaterias} materias en total en ${carreraNom}, con ${cursandoList.length} cursando actualmente).`;

  return {
    carrera: carreraNom,
    plan: planInfo.plan,
    totalMaterias,
    aprobadas: aprobadasList.length,
    faltantesParaRecibirse: restantesList.length,
    cursando: cursandoList.length,
    regularizadas: regularizadasList.length,
    porcentajeAvance: porcentaje,
    materiasEnCurso: cursandoList.map((m) => `${m.nombre} [${m.codigo}]`),
    materiasRestantesPorAnio,
    mensaje
  };
}

export interface ClaseHorario {
  materia: string;
  codigo?: string;
  comision?: string;
  dia: string;
  diaNumero: number;
  desde: string;
  hasta: string;
  tipoClase?: string;
  aula?: string;
  docentes?: string;
}

export interface HorarioSemanalInfo {
  carrera?: string;
  totalClasesSemana: number;
  diaFiltrado?: string;
  clases: ClaseHorario[];
  agendaPorDia: Record<string, ClaseHorario[]>;
  mensaje: string;
}

const DIAS_NOMBRE_MAP: Record<string, string> = {
  "1": "Domingo",
  "2": "Lunes",
  "3": "Martes",
  "4": "Miércoles",
  "5": "Jueves",
  "6": "Viernes",
  "7": "Sábado"
};

// Parser puro de horario semanal y asignaciones de clases
export function parseHorarioSemanal(rawText: string): ClaseHorario[] {
  let asignaciones: any[] = [];
  try {
    let cont = rawText;
    try {
      const j = JSON.parse(rawText);
      if (typeof j?.cont === "string") cont = j.cont;
    } catch {}
    const match = cont.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);\s*<\/script>/) ||
      cont.match(/kernel\.renderer\.on_arrival\(([\s\S]*?)\);/);
    if (match) {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data?.info?.asignaciones)) {
        asignaciones = data.info.asignaciones;
      }
    }
  } catch {}

  const clases: ClaseHorario[] = [];
  for (const asig of asignaciones) {
    const matName = asig.NOMBRE_MATERIA?.trim();
    if (!matName) continue;
    const diaNum = parseInt(asig.DIA_SEMANA, 10) || 0;
    const dia = DIAS_NOMBRE_MAP[asig.DIA_SEMANA] || `Día ${asig.DIA_SEMANA || "?"}`;
    const desde = asig.HS_COMIENZO_CLASE?.slice(0, 5) || "";
    const hasta = asig.HS_FINALIZ_CLASE?.slice(0, 5) || "";

    clases.push({
      materia: matName,
      codigo: asig.MATERIA?.trim() || undefined,
      comision: asig.NOMBRE?.trim() || undefined,
      dia,
      diaNumero: diaNum,
      desde,
      hasta,
      tipoClase: asig.TIPO_CLASE?.trim() || undefined,
      aula: asig.AULA?.trim() || undefined,
      docentes: asig.DOCENTES?.trim() || undefined
    });
  }

  // Ordenar cronológicamente por día de la semana (Lunes a Sábado) y luego por hora de inicio
  clases.sort((a, b) => {
    const dA = a.diaNumero === 1 ? 8 : a.diaNumero; // Domingo al final
    const dB = b.diaNumero === 1 ? 8 : b.diaNumero;
    if (dA !== dB) return dA - dB;
    return (a.desde || "").localeCompare(b.desde || "");
  });

  return clases;
}

// 8. Consultar horario semanal estructurado y clases del día ("¿Qué tengo hoy?")
export async function getHorarioSemanal(carrera?: string, diaFiltro?: string): Promise<HorarioSemanalInfo> {
  return withGuaraniLock(async () => {
    const { activa } = await ensureCarreraActiva(carrera);
  const calRes = await guaraniFetch("/calendario");
  const calRaw = await readGuaraniText(calRes);
  const todasClases = parseHorarioSemanal(calRaw);

  const normDia = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  let diaTarget: string | undefined;
  if (diaFiltro) {
    const dfNorm = normDia(diaFiltro);
    if (dfNorm === "hoy" || dfNorm === "today") {
      const hoyStr = new Date().toLocaleDateString("es-AR", {
        weekday: "long",
        timeZone: "America/Argentina/Buenos_Aires"
      });
      diaTarget = hoyStr.charAt(0).toUpperCase() + hoyStr.slice(1).toLowerCase();
      if (normDia(diaTarget).startsWith("miercol")) diaTarget = "Miércoles";
      if (normDia(diaTarget).startsWith("sabad")) diaTarget = "Sábado";
    } else {
      const match = Object.values(DIAS_NOMBRE_MAP).find((d) => normDia(d).startsWith(dfNorm.slice(0, 3)));
      diaTarget = match || diaFiltro;
    }
  }

  const clasesFiltradas = diaTarget
    ? todasClases.filter((c) => normDia(c.dia) === normDia(diaTarget!))
    : todasClases;

  const agendaPorDia: Record<string, ClaseHorario[]> = {};
  for (const c of clasesFiltradas) {
    if (!agendaPorDia[c.dia]) agendaPorDia[c.dia] = [];
    agendaPorDia[c.dia].push(c);
  }

  let mensaje: string;
  if (diaTarget) {
    if (clasesFiltradas.length > 0) {
      mensaje = `${diaFiltro?.toLowerCase() === "hoy" ? "Hoy " : ""}${diaTarget} tenés ${clasesFiltradas.length} clase(s):\n` +
        clasesFiltradas.map((c) => `· ${c.materia} (${c.desde} a ${c.hasta})${c.aula ? ` - Aula: ${c.aula}` : ""}${c.tipoClase ? ` [${c.tipoClase}]` : ""}`).join("\n");
    } else {
      mensaje = `${diaFiltro?.toLowerCase() === "hoy" ? "Hoy " : ""}${diaTarget} no tenés clases programadas en SIU Guaraní.`;
    }
  } else {
    mensaje = todasClases.length > 0
      ? `Tenés ${todasClases.length} clase(s) programada(s) en la semana para ${activa || "tu carrera"}.`
      : "No se encontraron clases programadas en el calendario de cursada.";
  }

    return {
      carrera: activa,
      totalClasesSemana: todasClases.length,
      diaFiltrado: diaTarget,
      clases: clasesFiltradas,
      agendaPorDia,
      mensaje
    };
  });
}

export interface MateriaRankingOptimo {
  nombre: string;
  codigo: string;
  anio: number;
  periodo: string;
  desbloqueosDirectos: string[];
  totalDesbloqueosTransitivas: number;
  desbloqueosTransitivas: string[];
  alturaCaminoCritico: number;
}

export interface PlanOptimoInfo {
  carrera?: string;
  plan?: string;
  totalMateriasPendientes: number;
  cuatrimestresMinimosEstimados: number;
  materiasHabilitadasRanking: MateriaRankingOptimo[];
  sugerenciaProximoCuatrimestre: string[];
  mensaje: string;
}

// 9. Plan óptimo de cursada: ranking por cierre transitivo de correlatividades y camino crítico
export async function getPlanOptimo(carrera?: string, maxMateriasSugeridas = 5): Promise<PlanOptimoInfo> {
  const planInfo = await getPlanEstudio(carrera);
  const cachePath = getPlanCachePath(planInfo.propuesta, planInfo.plan, planInfo.version);
  const graph = getGraph(cachePath);

  const pendientes = new Map<string, MateriaPlan>();
  for (const m of planInfo.materias) {
    if (m.estado !== "Aprobada" && m.estado !== "Promocionada") {
      pendientes.set(m.codigo || m.nombre, m);
    }
  }

  // Construir grafo de dependencias hacia adelante (X desbloquea a Y)
  const forwardGraph = new Map<string, Set<string>>();
  for (const m of planInfo.materias) {
    const keyM = m.codigo || m.nombre;
    if (!forwardGraph.has(keyM)) forwardGraph.set(keyM, new Set());

    if (m.elementoId && graph[m.elementoId]) {
      const reqs = [...(graph[m.elementoId].paraCursar || []), ...(graph[m.elementoId].paraAprobar || [])];
      for (const req of reqs) {
        const matReq = planInfo.materias.find(
          (mat) => (req.codigo && mat.codigo === req.codigo) || matchMateriaFilter(mat.nombre, req.materia)
        );
        if (matReq) {
          const keyReq = matReq.codigo || matReq.nombre;
          if (!forwardGraph.has(keyReq)) forwardGraph.set(keyReq, new Set());
          forwardGraph.get(keyReq)!.add(keyM);
        }
      }
    }
  }

  // Memoización para altura del camino crítico (DAG DFS)
  const alturaMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const getAltura = (key: string): number => {
    if (alturaMemo.has(key)) return alturaMemo.get(key)!;
    if (visiting.has(key)) return 1; // Prevenir ciclos
    visiting.add(key);

    let maxHijo = 0;
    const hijos = forwardGraph.get(key) || new Set();
    for (const h of hijos) {
      if (pendientes.has(h)) {
        maxHijo = Math.max(maxHijo, getAltura(h));
      }
    }
    visiting.delete(key);
    const alt = 1 + maxHijo;
    alturaMemo.set(key, alt);
    return alt;
  };

  const habilitadasKeys = new Set(planInfo.materiasHabilitadasParaCursar?.map((h) => h.codigo || h.nombre) || []);
  const ranking: MateriaRankingOptimo[] = [];

  for (const key of habilitadasKeys) {
    const mat = pendientes.get(key);
    if (!mat) continue;

    // Cierre transitivo vía BFS
    const visitados = new Set<string>();
    const queue = Array.from(forwardGraph.get(key) || []);
    while (queue.length > 0) {
      const nextKey = queue.shift()!;
      if (!visitados.has(nextKey) && pendientes.has(nextKey)) {
        visitados.add(nextKey);
        for (const grandchild of forwardGraph.get(nextKey) || []) {
          if (!visitados.has(grandchild)) queue.push(grandchild);
        }
      }
    }

    const directasPendientes = Array.from(forwardGraph.get(key) || [])
      .filter((k) => pendientes.has(k))
      .map((k) => pendientes.get(k)?.nombre || k);

    const transitivasPendientes = Array.from(visitados).map((k) => pendientes.get(k)?.nombre || k);
    const altura = getAltura(key);

    ranking.push({
      nombre: mat.nombre,
      codigo: mat.codigo,
      anio: mat.anio,
      periodo: mat.periodo,
      desbloqueosDirectos: directasPendientes,
      totalDesbloqueosTransitivas: transitivasPendientes.length,
      desbloqueosTransitivas: transitivasPendientes,
      alturaCaminoCritico: altura
    });
  }

  // Ordenar materias habilitadas:
  // 1. Mayor altura en el camino crítico (destraban cadenas largas de correlatividades)
  // 2. Mayor cantidad de materias desbloqueadas a futuro
  // 3. Menor año y período (priorizar materias base del plan)
  ranking.sort((a, b) => {
    if (b.alturaCaminoCritico !== a.alturaCaminoCritico) {
      return b.alturaCaminoCritico - a.alturaCaminoCritico;
    }
    if (b.totalDesbloqueosTransitivas !== a.totalDesbloqueosTransitivas) {
      return b.totalDesbloqueosTransitivas - a.totalDesbloqueosTransitivas;
    }
    return a.anio - b.anio;
  });

  const maxAltura = ranking.length > 0 ? Math.max(...ranking.map((r) => r.alturaCaminoCritico)) : 0;
  const cuatrimestresEstimados = Math.max(maxAltura, Math.ceil(pendientes.size / 5));

  const sugeridas = ranking.slice(0, maxMateriasSugeridas).map((r) => `${r.nombre} (${r.codigo}) - Año ${r.anio}`);

  const avisoParcial =
    planInfo.materiasSinVerificar && planInfo.materiasSinVerificar > 0
      ? `\n⚠️ Nota: Grafo de correlatividades en pre-calentamiento (${planInfo.materiasSinVerificar} materias pendientes aún sin verificar en segundo plano). Consultá nuevamente en unos segundos para la ruta definitiva.`
      : "";
  const mensaje = ranking.length > 0
    ? `Análisis de ruta crítica para ${planInfo.propuesta || "tu carrera"}:\n` +
      `· Materias pendientes: ${pendientes.size}\n` +
      `· Cuatrimestres mínimos estimados hasta recibirse: ~${cuatrimestresEstimados} cuatrimestre(s) (según cadena crítica de correlativas).\n` +
      `· Materia más crítica para cursar primero: '${ranking[0].nombre}' (cadena de ${ranking[0].alturaCaminoCritico} materias sucesivas, desbloquea ${ranking[0].totalDesbloqueosTransitivas} a futuro).\n` +
      `· Cursada sugerida próxima (${sugeridas.length} materias):\n` +
      sugeridas.map((s, idx) => `  ${idx + 1}. ${s}`).join("\n") +
      avisoParcial
    : `No tenés materias pendientes habilitadas para cursar en ${planInfo.propuesta || "tu carrera"}.` + avisoParcial;

  return {
    carrera: planInfo.propuesta,
    plan: planInfo.plan,
    totalMateriasPendientes: pendientes.size,
    cuatrimestresMinimosEstimados: cuatrimestresEstimados,
    materiasHabilitadasRanking: ranking,
    sugerenciaProximoCuatrimestre: sugeridas,
    mensaje
  };
}
