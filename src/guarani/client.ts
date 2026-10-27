import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { guaraniFetch, guaraniMutex } from "../shared/http.js";
import { logger } from "../shared/logger.js";
import { loadEncryptedSession, saveEncryptedSession } from "../auth/session.js";
import { withInterProcessLock } from "../auth/session-store.js";
import { CONFIG } from "../config.js";

// Bloqueo combinado intra-proceso (guaraniMutex) e inter-proceso (guarani.lock)
export async function withGuaraniLock<T>(fn: () => Promise<T>): Promise<T> {
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
      const pctMatch = /(\d+(?:\.\d+)?)/.exec(asistencia);
      if (pctMatch) {
        calculoFaltas = calcularFaltas(parseFloat(pctMatch[1]), inasistencias || 0);
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

    const pctMatch = /(\d+(?:\.\d+)?)/.exec(rightText);
    const porcentajeAsistencia = pctMatch ? parseFloat(pctMatch[1]) : 100;

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

    const inasistenciasTotales = detalles.reduce((sum, d) => sum + d.cantidad, 0);

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

// Descubre carreras disponibles en Guaraní, descarta cursos auxiliares y conmuta a la carrera académica objetivo
export async function ensureCarreraActiva(targetCarrera?: string): Promise<{
  activa?: string;
  disponibles: string[];
}> {
  const session = loadEncryptedSession();
  let disponibles: Array<{ id: string; nombre: string }> = session?.carrerasDisponibles || [];
  if (disponibles.some((c) => c.nombre.includes("\uFFFD"))) {
    disponibles = [];
  }

  if (disponibles.length === 0) {
    try {
      const res = await guaraniFetch("/inicio_alumno", {
        headers: { "X-Requested-With": "" }
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

      if (session) {
        session.carrerasDisponibles = disponibles;
        saveEncryptedSession(session);
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

    const changeRes = await guaraniFetch(`/acceso/cambiar_carrera?id=${encodeURIComponent(targetId)}&op=inicio_alumno`);
    if (!changeRes.ok) {
      throw new Error(`Error al conmutar a la carrera '${targetNombre}' en Guaraní (HTTP ${changeRes.status}).`);
    }

    // Verificación estricta del estado activo en el servidor para evitar inscribir en carrera equivocada
    const verifyRes = await guaraniFetch("/inicio_alumno", {
      headers: { "X-Requested-With": "" }
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

    if (session) {
      session.carreraActiva = targetNombre;
      saveEncryptedSession(session);
    }
    return { activa: targetNombre, disponibles: disponibles.map((c) => c.nombre) };
  }

  // 2. Si solo hay 1 carrera de grado/posgrado disponible, conmutar automáticamente para asegurar contexto en Guaraní
  if (disponibles.length === 1) {
    const unica = disponibles[0];
    try {
      await guaraniFetch(`/acceso/cambiar_carrera?id=${encodeURIComponent(unica.id)}&op=inicio_alumno`);
      if (session) {
        session.carreraActiva = unica.nombre;
        saveEncryptedSession(session);
      }
    } catch (err) {
      logger.warn(`Fallo al auto-conmutar a la carrera ${unica.nombre}: ${err}`);
    }
    return { activa: unica.nombre, disponibles: [unica.nombre] };
  }

  // 3. Múltiples carreras: leer la carrera activa real en el servidor para no etiquetar erróneamente
  let realActiva: string | undefined;
  try {
    const checkRes = await guaraniFetch("/inicio_alumno");
    const checkHtml = unwrapChulupiHtml(await readGuaraniText(checkRes));
    realActiva = extractActiveCareerFromHtml(checkHtml);
  } catch {}

  const activa = realActiva || session?.carreraActiva || disponibles[0]?.nombre;
  if (session && realActiva && session.carreraActiva !== realActiva) {
    session.carreraActiva = realActiva;
    saveEncryptedSession(session);
  }
  return { activa, disponibles: disponibles.map((c) => c.nombre) };
}

// 1. Obtener estado de cursadas activas e inasistencias acumuladas
export async function getEstadoCursada(carrera?: string): Promise<CursadaInfo[]> {
  return withGuaraniLock(async () => {
    try {
      await ensureCarreraActiva(carrera);

      // 1. Obtener inasistencias detalladas y porcentajes desde /reporte_inasistencias
      let inasistenciasList: InasistenciasMateriaParsed[] = [];
      try {
        const inasRes = await guaraniFetch("/reporte_inasistencias");
        const inasRaw = await readGuaraniText(inasRes);
        inasistenciasList = parseReporteInasistencias(unwrapChulupiHtml(inasRaw));
      } catch (err) {
        logger.warn(`No se pudo obtener /reporte_inasistencias: ${err}`);
      }

      // 2. Obtener cursadas activas y horarios desde /calendario
      let cursadas: CursadaInfo[] = [];
      try {
        const calRes = await guaraniFetch("/calendario");
        const calRaw = await readGuaraniText(calRes);
        cursadas = parseCalendarioAsignaciones(calRaw);
      } catch (err) {
        logger.warn(`No se pudo obtener /calendario: ${err}`);
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
        const match = inasistenciasList.find(
          (ina) =>
            (cur.codigo && ina.codigo && cur.codigo.toLowerCase() === ina.codigo.toLowerCase()) ||
            matchMateriaFilter(cur.materia, ina.materia)
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
        const already = cursadas.some(
          (c) =>
            (c.codigo && inas.codigo && c.codigo.toLowerCase() === inas.codigo.toLowerCase()) ||
            matchMateriaFilter(c.materia, inas.materia)
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

      return cursadas;
    } catch (err) {
      logger.error("Error al obtener estado de cursada en Guaraní", err);
      throw err;
    }
  });
}

// 2. Obtener historia académica completa y analítico
export async function getHistoriaAcademica(carrera?: string): Promise<HistoriaAcademicaInfo> {
  return withGuaraniLock(async () => {
    try {
      const { activa, disponibles } = await ensureCarreraActiva(carrera);
      const res = await guaraniFetch("/historia_academica");
      const rawText = await readGuaraniText(res);
      const html = unwrapChulupiHtml(rawText);

      const parsed = parseHistoriaAcademica(html, {
        carreraActiva: activa,
        carrerasDisponibles: disponibles.length > 1 ? disponibles : undefined
      });

      // Si no encontró promedios o avance en la vista principal, consultar endpoint dedicado
      if (parsed.promedioSinAplazos === undefined || parsed.porcentajeAvance === undefined) {
        try {
          const avanceRes = await guaraniFetch("/porcentaje_avance_carrera");
          const avanceRaw = await readGuaraniText(avanceRes);
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
      } else if (rawNotaLower.includes("aprobad") || rawNotaLower.includes("aprob")) {
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

// 4. Obtener plan de estudio interactivo y análisis de correlatividades / impacto
export async function getPlanEstudio(
  carrera?: string,
  targetMateria?: string
): Promise<PlanEstudiosInfo> {
  return withGuaraniLock(async () => {
    try {
      await ensureCarreraActiva(carrera);
      const res = await guaraniFetch("/plan_estudio");
      const rawText = await readGuaraniText(res);
      const planInfo = parsePlanEstudio(unwrapChulupiHtml(rawText));

      // Sincronizar estados de materias cursando actualmente
      try {
        let cursadas: CursadaInfo[] = [];
        try {
          const calRes = await guaraniFetch("/calendario");
          const calRaw = await readGuaraniText(calRes);
          cursadas = parseCalendarioAsignaciones(calRaw);
        } catch {}
        if (cursadas.length === 0) {
          const cursadasRes = await guaraniFetch("/cursada");
          const cursadasHtml = unwrapChulupiHtml(await readGuaraniText(cursadasRes));
          cursadas = parseCursadas(cursadasHtml);
        }
        for (const c of cursadas) {
          const match = planInfo.materias.find(
            (m) =>
              (c.codigo && m.codigo && c.codigo.toLowerCase() === m.codigo.toLowerCase()) ||
              matchMateriaFilter(m.nombre, c.materia)
          );
          if (match && match.estado === "Pendiente") {
            match.estado = "Cursando";
          }
        }
      } catch {}

      if (targetMateria) {
        const normTarget = normalizeMateria(targetMateria);
        const mat = planInfo.materias.find(
          (m) =>
            normalizeMateria(m.nombre) === normTarget ||
            m.codigo.toLowerCase() === normTarget.toLowerCase() ||
            matchMateriaFilter(m.nombre, targetMateria)
        );

        if (mat) {
          const cachePath = getPlanCachePath(planInfo.propuesta, planInfo.plan, planInfo.version);
          const planCorrCache = loadPlanCorrelativasCache(cachePath);
          let cacheDirty = false;

          const fetchCorrelativasForElement = async (elementoId: string, elementoPadreId: string) => {
            if (planCorrCache[elementoId]) {
              return planCorrCache[elementoId];
            }
            const body = new URLSearchParams({
              elemento: elementoId,
              elemento_padre: elementoPadreId
            });
            const corrRes = await guaraniFetch("/plan_estudio/correlativas", {
              method: "POST",
              body,
              headers: { "Content-Type": "application/x-www-form-urlencoded" }
            });
            const corrHtml = unwrapChulupiHtml(await readGuaraniText(corrRes));
            const parsed = parseCorrelativasHtml(corrHtml);
            planCorrCache[elementoId] = parsed;
            cacheDirty = true;
            return parsed;
          };

          // 1. Correlativas de la materia consultada
          if (mat.elementoId && mat.elementoPadreId) {
            try {
              const { paraCursar, paraAprobar } = await fetchCorrelativasForElement(
                mat.elementoId,
                mat.elementoPadreId
              );

              // Evaluar cumplimiento de cada correlativa contra el estado del alumno
              for (const req of paraCursar) {
                const reqMat = planInfo.materias.find(
                  (m) =>
                    (req.codigo && m.codigo === req.codigo) ||
                    matchMateriaFilter(m.nombre, req.materia)
                );
                req.estadoActual = reqMat ? reqMat.estado : "Pendiente";
                if (req.condicionRequerida === "Regularizada") {
                  req.cumple =
                    req.estadoActual === "Regularizada" ||
                    req.estadoActual === "Aprobada" ||
                    req.estadoActual === "Promocionada";
                } else {
                  req.cumple = req.estadoActual === "Aprobada" || req.estadoActual === "Promocionada";
                }
              }

              for (const req of paraAprobar) {
                const reqMat = planInfo.materias.find(
                  (m) =>
                    (req.codigo && m.codigo === req.codigo) ||
                    matchMateriaFilter(m.nombre, req.materia)
                );
                req.estadoActual = reqMat ? reqMat.estado : "Pendiente";
                req.cumple = req.estadoActual === "Aprobada" || req.estadoActual === "Promocionada";
              }

              mat.correlativasParaCursar = paraCursar;
              mat.correlativasParaAprobar = paraAprobar;
            } catch (err) {
              logger.warn(`No se pudieron obtener correlativas para ${mat.nombre}: ${err}`);
            }
          } else {
            mat.correlativasParaCursar = [];
            mat.correlativasParaAprobar = [];
          }

          // 2. Análisis de impacto a futuro: descubrir qué materias posteriores dependen de esta
          const materiasDependientes: NonNullable<MateriaPlan["materiasQueDependenDeEsta"]> = [];
          const candidatasFuturas = planInfo.materias.filter((m) => isPotentialDependent(m, mat));
          const missingCandidates = candidatasFuturas.filter((c) => !planCorrCache[c.elementoId!]);

          // Limitar a un tope de 25 solicitudes por ejecución y concurrencia 4 para prevenir sobrecarga de Guaraní en caché fría
          const toFetch = missingCandidates.slice(0, 25);
          if (toFetch.length > 0) {
            const CONCURRENCY = 4;
            let qIdx = 0;
            const workers = Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, async () => {
              while (qIdx < toFetch.length) {
                const fut = toFetch[qIdx++];
                try {
                  await fetchCorrelativasForElement(fut.elementoId!, fut.elementoPadreId!);
                } catch {}
              }
            });
            await Promise.all(workers);
          }

          if (cacheDirty) {
            savePlanCorrelativasCache(cachePath, planCorrCache);
          }

          for (const fut of candidatasFuturas) {
            const fCorr = planCorrCache[fut.elementoId!];
            if (!fCorr) continue;

            const requiereCursar = fCorr.paraCursar.some(
              (r) =>
                (r.codigo && r.codigo === mat.codigo) ||
                matchMateriaFilter(r.materia, mat.nombre)
            );
            const requiereAprobar = fCorr.paraAprobar.some(
              (r) =>
                (r.codigo && r.codigo === mat.codigo) ||
                matchMateriaFilter(r.materia, mat.nombre)
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

          if (materiasDependientes.length > 0) {
            lines.push(
              `Impacto a futuro (materias que trabaría si no se aprueba): ` +
                materiasDependientes
                  .map((d) => `${d.materia} (${d.codigo}, ${d.anio}° Año - para ${d.requierePara})`)
                  .join(", ")
            );
          } else {
            lines.push("Impacto a futuro: No es correlativa directa de materias posteriores del plan.");
          }

          planInfo.resumenImpacto = lines.join("\n");
        }
      }

      return planInfo;
    } catch (err) {
      logger.error("Error al obtener plan de estudio en Guaraní", err);
      throw err;
    }
  });
}
