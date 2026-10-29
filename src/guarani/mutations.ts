import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { guaraniFetch } from "../shared/http.js";
import { getMesasDisponibles, ensureCarreraActiva, unwrapChulupiHtml, withGuaraniLock, readGuaraniText, matchMateriaFilter } from "./client.js";
import { showNativeConfirmation } from "../shared/native-confirm.js";
import { logger } from "../shared/logger.js";
import { CONFIG } from "../config.js";

export interface InscribirExamenParams {
  carrera: string;
  materia: string;
  llamadoId: string;
}

export interface InscribirExamenResult {
  exito: boolean;
  aprobado?: boolean;
  instruccion?: string;
  mensaje: string;
  comprobante?: string;
  detalles?: Record<string, unknown>;
}

// Helper puro para parsear la respuesta de mutación de examen de Guaraní (JSON o HTML Chulupi)
export function parseGuaraniInscripcionResponse(resText: string): {
  errorMsg?: string;
  comprobanteText?: string;
} {
  let errorMsg: string | undefined;
  let comprobanteText: string | undefined;

  try {
    const json = JSON.parse(resText);
    if (json.cod === "-1" || json.cod === -1 || json.error) {
      errorMsg = json.msg || json.error || json.mensaje || "Error retornado por Guaraní al procesar la inscripción";
    } else if (json.comprobante || json.nro_transaccion) {
      comprobanteText = String(json.comprobante || json.nro_transaccion);
    } else if (json.cont) {
      const $cont = cheerio.load(json.cont);
      const err = $cont(".alert-danger, .alert-error, .error, .mensaje-error").text().trim();
      if (err) errorMsg = err;
      comprobanteText = $cont(".comprobante, .alert-success, .numero-comprobante").text().trim() || undefined;
    }
  } catch {
    const $res = cheerio.load(resText);
    const err = $res(".alert-danger, .alert-error, .mensaje-error, .error").text().trim();
    if (err) errorMsg = err;
    comprobanteText = $res(".comprobante, .alert-success, .numero-comprobante, .nro-transaccion").text().trim() || undefined;
  }

  return { errorMsg, comprobanteText };
}

// Inscripción a examen final en SIU Guaraní con ciclo atómico en dos fases y confirmación física en Canal B
export async function inscribirExamen(
  params: InscribirExamenParams,
  onProgress?: (msg: string, pct?: number) => Promise<void> | void
): Promise<InscribirExamenResult> {
  const { carrera, materia, llamadoId } = params;

  // ==========================================
  // FASE 1: Consulta y Presentación en Canal B
  // (Sin retener ningún mutex de sesión)
  // ==========================================
  await onProgress?.("Consultando mesas de examen en SIU Guaraní...");
  const mesas = await getMesasDisponibles(carrera, materia);
  const mesa = mesas.find((m) => m.llamadoId === llamadoId);

  if (!mesa) {
    throw new Error(
      `No se encontró ninguna mesa de examen con llamadoId '${llamadoId}' para la materia '${materia}'. Consultá 'guarani_mesas_disponibles' para verificar los llamados vigentes.`
    );
  }

  if (!mesa.llamadoId || mesa.llamadoId.startsWith("mesa_")) {
    throw new Error(
      `No se pudo identificar el código formal de llamado provisto por Guaraní para la mesa de '${materia}'. No es posible procesar la inscripción con un identificador de respaldo.`
    );
  }

  if (!mesa.inscripcionAbierta) {
    throw new Error(
      `La inscripción para la mesa de '${materia}' del ${mesa.fecha} se encuentra actualmente cerrada en SIU Guaraní.`
    );
  }

  const detalleConfirmacion = `Materia: ${mesa.materia}\nCarrera: ${carrera}\nLlamado / Turno: ${mesa.llamadoId}\nFecha y hora: ${mesa.fecha || "A confirmar"}${mesa.hora ? ` a las ${mesa.hora}` : ""}\nCondición: ${mesa.condicionPermitida || "No verificado"}\nTribunal: ${mesa.tribunal || "A designar"}\n\nNota: La baja de examen no puede realizarse vía MCP; debe gestionarse en https://guarani.uca.edu.ar`;

  const aprobado = await showNativeConfirmation(
    {
      titulo: "Confirmar inscripción a examen final - SIU Guaraní",
      accion: "Inscripción formal a mesa de examen",
      entidad: `${mesa.materia} (${carrera})`,
      detalle: detalleConfirmacion
    },
    (tick = 1) => onProgress?.(`Esperando confirmación física en Canal B... (${tick * 4}s)`, 50 + Math.min(45, tick * 3))
  );

  if (!aprobado) {
    logger.info(`Inscripción a examen para ${materia} cancelada por el usuario en Canal B`);
    return {
      exito: false,
      aprobado: false,
      mensaje: "Inscripción cancelada por el usuario en el diálogo de autorización.",
      instruccion: "El usuario denegó explícitamente la confirmación para inscribirse a esta mesa de examen. NO reintentes la inscripción a menos que el usuario lo solicite de forma expresa."
    };
  }

  // ==========================================
  // FASE 2: Mutación Atómica Post-Aprobación
  // (Con cerrojo re-entrante guaraniMutex y lock inter-proceso)
  // ==========================================
  await onProgress?.("Confirmando inscripción formal dentro de SIU Guaraní...");
  return withGuaraniLock(async () => {
    try {
      // 0. Re-conmutar y verificar la carrera activa dentro del bloqueo para prevenir TOCTOU
      await ensureCarreraActiva(carrera, true);

      // 1. Obtener catálogo y token anti-CSRF fresco
      const pageRes = await guaraniFetch("/inscripcion_examen");
      const pageRaw = await readGuaraniText(pageRes);
      const pageHtml = unwrapChulupiHtml(pageRaw);
      const $ = cheerio.load(pageHtml);

      const csrf =
        $('input[name="__csrf"]').val()?.toString() ||
        $('meta[name="csrf-token"]').attr("content") ||
        "";

      // 2. Re-verificación de integridad TOCTOU con parseo estructurado de la página fresca
      let mesaActual: { llamadoId: string; inscripcionAbierta: boolean; fecha?: string; hora?: string } | undefined;

      $(".mesa-examen, tr.mesa, .item-mesa").each((_, el) => {
        const matNombre = $(el).find(".materia, td.materia, h4").first().text().trim();
        if (!matchMateriaFilter(matNombre, materia)) return;

        const rawFecha = $(el).find(".fecha, td.fecha").first().text().trim() || undefined;
        const rawHora = $(el).find(".hora, td.hora").first().text().trim() || undefined;
        const cleanMateria = (matNombre || materia).toLowerCase().replace(/[^a-z0-9]/g, "_");
        const cleanFecha = (rawFecha || "").replace(/[^0-9]/g, "");
        const fallbackId = `mesa_${cleanMateria}${cleanFecha ? `_${cleanFecha}` : ""}`;

        const currLlamadoId =
          $(el).attr("data-llamado") ||
          $(el).attr("data-mesa") ||
          $(el).find('input[name="llamado"], input[name="mesa"]').val()?.toString() ||
          fallbackId;

        if (currLlamadoId === llamadoId) {
          const inscripcionAbierta = !$(el).hasClass("cerrada") && !$(el).find(".cerrada, .inactiva").length;
          mesaActual = { llamadoId: currLlamadoId, inscripcionAbierta, fecha: rawFecha, hora: rawHora };
        }
      });

      if (!mesaActual) {
        throw new Error(
          `La mesa de examen con llamadoId '${llamadoId}' ya no se encuentra listada en SIU Guaraní (posible cambio de estado o turno cerrado).`
        );
      }

      if (!mesaActual.inscripcionAbierta) {
        throw new Error(
          `La inscripción para la mesa de '${materia}' cerró entre la confirmación y el envío en SIU Guaraní.`
        );
      }

      if (mesaActual.fecha !== mesa.fecha || mesaActual.hora !== mesa.hora) {
        throw new Error(
          `Las condiciones de fecha/hora de la mesa cambiaron tras la confirmación (registrado: ${mesa.fecha || "A confirmar"} ${mesa.hora || ""}, actual: ${mesaActual.fecha || "A confirmar"} ${mesaActual.hora || ""}).`
        );
      }

      // 3. Despachar POST de inscripción
      const postBody = new URLSearchParams({
        __csrf: csrf,
        carrera,
        materia,
        llamado: llamadoId
      });

      const response = await guaraniFetch("/inscripcion_examen/inscribir", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: postBody.toString()
      });

      const resText = await readGuaraniText(response);
      let { errorMsg, comprobanteText } = parseGuaraniInscripcionResponse(resText);

      if (errorMsg || !response.ok) {
        throw new Error(`Fallo en la inscripción de examen en SIU Guaraní: ${errorMsg || `HTTP ${response.status}`}`);
      }

      // Si la respuesta no trajo comprobante explícito, releer la página para confirmar que la mesa figura inscripta
      if (!comprobanteText) {
        const checkRes = await guaraniFetch("/inscripcion_examen");
        const checkRaw = await readGuaraniText(checkRes);
        const checkHtml = unwrapChulupiHtml(checkRaw);
        const $check = cheerio.load(checkHtml);
        const yaInscripto = $check(".inscripto, .mesa-inscripta, tr.inscripta")
          .filter((_, el) => $check(el).text().toLowerCase().includes(materia.toLowerCase()))
          .length > 0;

        if (!yaInscripto) {
          logger.warn(`Inscripción a ${materia} en estado indeterminado tras POST.`);
          return {
            exito: false,
            aprobado: true,
            mensaje: `Estado desconocido: La solicitud de inscripción a ${materia} fue procesada por el servidor pero no devolvió código de comprobante ni se reflejó en el listado de inscriptos. NO reintentes esta operación para evitar registros duplicados o inconsistencias. Verificá tu situación académica en https://guarani.uca.edu.ar`,
            instruccion: "NO reintentes esta operación. Verificá el estado de inscripción directamente en el portal de Guaraní.",
            detalles: {
              carrera,
              materia,
              llamadoId,
              fecha: mesa.fecha,
              hora: mesa.hora
            }
          };
        }
        comprobanteText = `Confirmada en SIU Guaraní (sin código alfanumérico explícito)`;
      }

      logger.audit("examen_inscripto", { carrera, materia, llamadoId, comprobante: comprobanteText });

      return {
        exito: true,
        comprobante: comprobanteText,
        mensaje: `Inscripción confirmada en SIU Guaraní para ${materia}. Comprobante: ${comprobanteText}. Si necesitás darte de baja, deberás hacerlo en https://guarani.uca.edu.ar`,
        detalles: {
          carrera,
          materia,
          llamadoId,
          fecha: mesa.fecha,
          hora: mesa.hora
        }
      };
    } catch (err) {
      logger.error(`Error al ejecutar inscripción en Guaraní para ${materia}`, err);
      throw err;
    }
  });
}

export type TipoConstancia =
  | "alumno_regular"
  | "actividades_aprobadas"
  | "examen_final"
  | "examen_parcial"
  | "promedio_academico";

export interface SolicitarCertificadoParams {
  carrera?: string;
  tipoConstancia?: TipoConstancia;
  presentarA?: string;
  copias?: number;
  observaciones?: string;
  forzarNueva?: boolean;
}

export interface SolicitarCertificadoResult {
  exito: boolean;
  aprobado?: boolean;
  mensaje: string;
  tipoConstancia: string;
  presentarA: string;
  copias: number;
  rutaArchivoPdf?: string;
  comprobante?: string;
  instruccion?: string;
  detalles?: Record<string, unknown>;
}

// shortcut: IDs hardcodeados para la Facultad de Ingeniería (prefijo 15-), actualizar con descubrimiento dinámico de /solicitudes/nueva_solicitud para facultades no técnicas (Derecho, Medicina, Económicas).
export const CONSTANCIAS_MAP: Record<TipoConstancia, { id: string; form: string; nombre: string }> = {
  alumno_regular: { id: "172", form: "34000240", nombre: "15-Constancia de Alumno Regular Ing" },
  actividades_aprobadas: { id: "134", form: "", nombre: "15-Constancia de Actividades Aprobadas Ing" },
  examen_final: { id: "173", form: "34000236", nombre: "15-Constancia de Examen Final Ing" },
  examen_parcial: { id: "174", form: "37000562", nombre: "15-Constancia de Examen Parcial Ing" },
  promedio_academico: { id: "175", form: "", nombre: "15-Constancia de Promedio Académico Ing" }
};

export interface OpcionConstancia {
  id: string;
  form: string;
  nombre: string;
}

// Parser puro para opciones disponibles de constancias en /solicitudes/nueva_solicitud
export function parseOpcionesConstancia(html: string): OpcionConstancia[] {
  const $ = cheerio.load(unwrapChulupiHtml(html));
  const opciones: OpcionConstancia[] = [];
  $("select#constancia option, select[name='constancia'] option").each((_, opt) => {
    const id = $(opt).attr("value");
    if (!id || id === "0") return;
    const form = $(opt).attr("data-formulario") || "";
    const nombre = $(opt).text().replace(/\s+/g, " ").trim();
    if (nombre) {
      opciones.push({ id, form, nombre });
    }
  });
  return opciones;
}

export interface SolicitudListadoItem {
  id?: string;
  tipo: string;
  fecha?: string;
  presentarA?: string;
  estado?: string;
  urlDescarga?: string;
  rutaLocal?: string;
}

// Parser puro para listado de solicitudes en SIU Guaraní
export function parseSolicitudesListado(html: string): SolicitudListadoItem[] {
  const $ = cheerio.load(unwrapChulupiHtml(html));
  const items: SolicitudListadoItem[] = [];

  $("table tbody tr, tr.solicitud, .solicitud-item").each((_, tr) => {
    const text = $(tr).text().replace(/\s+/g, " ").trim();
    if (!text || text.includes("No hay solicitudes")) return;

    const downloadLink = $(tr).find("a[href*='descargar'], a[href*='pdf'], a.btn-descargar, a[title*='escargar']").first();
    const urlDescarga = downloadLink.attr("href") || undefined;
    const idMatch = urlDescarga?.match(/(?:id|solicitud|archivo)[=\/](\d+)/i) || $(tr).attr("data-id") || $(tr).attr("id");
    const id = typeof idMatch === "string" ? idMatch : idMatch ? idMatch[1] : undefined;
    const cells = $(tr).find("td").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();

    const tipo = cells[1] || cells[0] || text;
    const presentarA = cells[2] || undefined;
    const estado = cells[3] || undefined;
    const fecha = cells[4] || undefined;

    items.push({
      id,
      tipo,
      fecha,
      presentarA,
      estado,
      urlDescarga
    });
  });

  return items;
}

// Emisión y descarga directa en PDF de constancia institucional en SIU Guaraní
export async function solicitarCertificadoAlumnoRegular(
  params: SolicitarCertificadoParams = {},
  onProgress?: (msg: string, pct?: number) => Promise<void> | void
): Promise<SolicitarCertificadoResult> {
  const {
    carrera,
    tipoConstancia = "alumno_regular",
    presentarA = "A quien corresponda",
    copias = 1,
    observaciones = "",
    forzarNueva = false
  } = params;

  let constanciaInfo: { id: string; form: string; nombre: string } | undefined;
  const safeCopias = Math.max(1, Math.min(5, copias));

  // 1. Asegurar carrera activa y descubrir dinámicamente las constancias disponibles para la facultad del alumno
  const actRes = await ensureCarreraActiva(carrera, true);
  const activeCareer = actRes.activa || carrera;

  try {
    const formRes = await guaraniFetch("/solicitudes/nueva_solicitud");
    const formHtml = await readGuaraniText(formRes);
    const opciones = parseOpcionesConstancia(formHtml);
    if (opciones.length > 0) {
      const match = opciones.find((o) => {
        const nom = o.nombre.toLowerCase();
        if (tipoConstancia === "alumno_regular") return nom.includes("alumno regular") || nom.includes("regular");
        if (tipoConstancia === "actividades_aprobadas") return nom.includes("actividades aprobadas") || nom.includes("aprobadas");
        if (tipoConstancia === "examen_final") return nom.includes("examen final") || nom.includes("final");
        if (tipoConstancia === "examen_parcial") return nom.includes("examen parcial") || nom.includes("parcial");
        if (tipoConstancia === "promedio_academico") return nom.includes("promedio");
        return false;
      });
      if (match) {
        constanciaInfo = match;
      } else {
        throw new Error(
          `SIU Guaraní no ofrece la constancia '${tipoConstancia}' para '${activeCareer || "tu carrera"}'. Opciones disponibles: ${opciones.map((o) => o.nombre).join(", ")}`
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("SIU Guaraní no ofrece")) throw err;
    logger.warn(`No se pudieron descubrir opciones dinámicas de constancia: ${err}`);
  }

  // Si no se descubrió dinámicamente, solo permitir fallback de Ingeniería si la carrera está confirmada como Ingeniería
  if (!constanciaInfo) {
    if (activeCareer?.toLowerCase().includes("ingenier")) {
      constanciaInfo = CONSTANCIAS_MAP[tipoConstancia] || CONSTANCIAS_MAP.alumno_regular;
    } else {
      throw new Error(
        `No se pudieron descubrir las constancias habilitadas en SIU Guaraní para '${activeCareer || "tu carrera"}'. Por seguridad, se aborta la solicitud para evitar emitir constancias con códigos de otra facultad.`
      );
    }
  }

  // 2. Si no se fuerza nueva solicitud, verificar si ya existe una solicitud emitida reciente con PDF disponible
  if (!forzarNueva) {
    await onProgress?.("Verificando solicitudes existentes en SIU Guaraní...");
    try {
      const listRes = await guaraniFetch("/solicitudes");
      const listHtml = unwrapChulupiHtml(await readGuaraniText(listRes));
      const existentes = parseSolicitudesListado(listHtml);

      // Solo reutilizar si fue emitida recientemente (últimos 30 días)
      const esReciente = (fechaStr?: string): boolean => {
        if (!fechaStr) return false;
        const m = fechaStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (!m) return false;
        const emision = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
        const diffDias = (Date.now() - emision.getTime()) / (1000 * 60 * 60 * 24);
        return diffDias >= 0 && diffDias <= 30;
      };

      const parseFecha = (fechaStr?: string): number => {
        if (!fechaStr) return 0;
        const m = fechaStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        return m ? new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10)).getTime() : 0;
      };

      // Ordenar por fecha descendente para encontrar la más nueva disponible con destinatario compatible
      const normPres = (s?: string) => (s || "").toLowerCase().trim();
      const targetPres = normPres(presentarA);
      const esDestinatarioCompatible = (sPres?: string): boolean => {
        if (!targetPres || targetPres === "a quien corresponda") return true;
        const sNorm = normPres(sPres);
        return sNorm.includes(targetPres) || targetPres.includes(sNorm);
      };

      const candidatos = existentes
        .filter(
          (s) =>
            Boolean(s.urlDescarga) &&
            (s.tipo.toLowerCase().includes(constanciaInfo.nombre.toLowerCase()) ||
              (tipoConstancia === "alumno_regular" && s.tipo.toLowerCase().includes("alumno regular"))) &&
            esDestinatarioCompatible(s.presentarA)
        )
        .sort((a, b) => parseFecha(b.fecha) - parseFecha(a.fecha));

      const existente = candidatos.find((s) => esReciente(s.fecha));

      if (existente?.urlDescarga) {
        await onProgress?.("Descargando PDF de constancia vigente...");
        const u = new URL(existente.urlDescarga, CONFIG.GUARANI_BASE_URL);
        const pdfRes = await guaraniFetch(u.pathname + u.search);
        const pdfBuf = new Uint8Array(await pdfRes.arrayBuffer());

        if (pdfBuf.length > 50 && pdfBuf[0] === 0x25 && pdfBuf[1] === 0x50 && pdfBuf[2] === 0x44 && pdfBuf[3] === 0x46) {
          const safeName = `constancia_${tipoConstancia}_${Date.now()}.pdf`;
          const destPath = path.join(CONFIG.CERTIFICADOS_DIR, safeName);
          fs.mkdirSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, mode: 0o700 });
          fs.writeFileSync(destPath, pdfBuf);
          return {
            exito: true,
            aprobado: true,
            mensaje: `Constancia oficial vigente (emitida el ${existente.fecha}) recuperada de SIU Guaraní y descargada con éxito en PDF.`,
            tipoConstancia: constanciaInfo.nombre,
            presentarA: existente.presentarA || presentarA,
            copias: safeCopias,
            rutaArchivoPdf: destPath,
            comprobante: existente.id || "Constancia vigente en Guaraní",
            detalles: {
              fechaEmision: existente.fecha,
              estado: existente.estado
            }
          };
        }
      }
    } catch (e) {
      logger.warn(`No se pudo consultar listado de solicitudes previas: ${e}`);
    }
  }

  // 3. Confirmación física en Canal B para emitir nueva constancia institucional
  await onProgress?.("Presentando confirmación en Canal B...", 30);
  const aprobado = await showNativeConfirmation(
    {
      titulo: "Confirmar solicitud de constancia - SIU Guaraní",
      accion: "Emisión formal de constancia universitaria",
      entidad: `${constanciaInfo.nombre} (${activeCareer || "Carrera activa"})`,
      detalle: `Tipo: ${constanciaInfo.nombre}\nPresentar a: ${presentarA}\nCopias: ${safeCopias}\n${observaciones ? `Observaciones: ${observaciones}\n` : ""}\nNota: Esta acción registrará formalmente una solicitud de constancia oficial con código de verificación institucional en tu legajo de SIU Guaraní.`
    },
    (tick = 1) => onProgress?.(`Esperando confirmación física en Canal B... (${tick * 4}s)`, 50)
  );

  if (!aprobado) {
    logger.info(`Solicitud de constancia ${constanciaInfo.nombre} cancelada por el usuario en Canal B`);
    return {
      exito: false,
      aprobado: false,
      mensaje: "Solicitud de constancia cancelada por el usuario en Canal B.",
      tipoConstancia: constanciaInfo.nombre,
      presentarA,
      copias: safeCopias,
      instruccion: "El usuario denegó o canceló la confirmación física."
    };
  }

  // 4. Ejecutar solicitud formal en SIU Guaraní bajo cerrojo atómico
  return withGuaraniLock(async () => {
    await onProgress?.("Enviando solicitud formal a SIU Guaraní...", 75);
    try {
      // 0. Re-asegurar carrera activa bajo el cerrojo para prevenir TOCTOU
      await ensureCarreraActiva(carrera, true);

      // Snapshot de URLs de solicitudes existentes para detectar con precisión el nuevo registro
      const previousUrls = new Set<string>();
      try {
        const prevListRes = await guaraniFetch("/solicitudes");
        const prevListHtml = unwrapChulupiHtml(await readGuaraniText(prevListRes));
        for (const s of parseSolicitudesListado(prevListHtml)) {
          if (s.urlDescarga) previousUrls.add(s.urlDescarga);
        }
      } catch {}

      const body = new URLSearchParams({
        constancia: constanciaInfo.id,
        copias: String(safeCopias),
        presentar: presentarA,
        observaciones: observaciones || "",
        formulario: constanciaInfo.form,
        formulario_campo: "",
        formulario_valor: ""
      });

      const response = await guaraniFetch("/solicitudes/nueva_solicitud", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });

      const rawText = await readGuaraniText(response);
      const parsedRes = parseGuaraniInscripcionResponse(rawText);

      if (parsedRes.errorMsg) {
        throw new Error(`SIU Guaraní rechazó la emisión de la constancia: ${parsedRes.errorMsg}`);
      }

      // Releer listado de solicitudes para obtener enlace de descarga del PDF generado
      await onProgress?.("Obteniendo constancia emitida en PDF...", 90);
      const listRes = await guaraniFetch("/solicitudes");
      const listHtml = unwrapChulupiHtml(await readGuaraniText(listRes));
      const solicitudes = parseSolicitudesListado(listHtml);
      // Priorizar solicitud nueva no presente en el snapshot previo
      const nueva =
        solicitudes.find(
          (s) =>
            s.urlDescarga &&
            !previousUrls.has(s.urlDescarga) &&
            (s.tipo.toLowerCase().includes(constanciaInfo.nombre.toLowerCase()) ||
              (tipoConstancia === "alumno_regular" && s.tipo.toLowerCase().includes("alumno regular")))
        ) ||
        solicitudes.find(
          (s) =>
            s.tipo.toLowerCase().includes(constanciaInfo.nombre.toLowerCase()) ||
            (tipoConstancia === "alumno_regular" && s.tipo.toLowerCase().includes("alumno regular"))
        );

      let destPath: string | undefined;
      if (nueva?.urlDescarga) {
        const u = new URL(nueva.urlDescarga, CONFIG.GUARANI_BASE_URL);
        const pdfRes = await guaraniFetch(u.pathname + u.search);
        const pdfBuf = new Uint8Array(await pdfRes.arrayBuffer());

        if (pdfBuf.length > 50 && pdfBuf[0] === 0x25 && pdfBuf[1] === 0x50 && pdfBuf[2] === 0x44 && pdfBuf[3] === 0x46) {
          const safeName = `constancia_${tipoConstancia}_${Date.now()}.pdf`;
          destPath = path.join(CONFIG.CERTIFICADOS_DIR, safeName);
          fs.mkdirSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, mode: 0o700 });
          fs.writeFileSync(destPath, pdfBuf);
        }
      }

      logger.audit("constancia_solicitada", {
        tipo: constanciaInfo.nombre,
        presentarA,
        copias: safeCopias,
        pdfGenerado: Boolean(destPath)
      });

      return {
        exito: true,
        aprobado: true,
        mensaje: destPath
          ? `Constancia oficial emitida y descargada exitosamente en PDF.`
          : `Solicitud de constancia registrada formalmente en SIU Guaraní. El documento quedó en estado '${nueva?.estado || "En trámite"}' en tu cuenta.`,
        tipoConstancia: constanciaInfo.nombre,
        presentarA,
        copias: safeCopias,
        rutaArchivoPdf: destPath,
        comprobante: nueva?.id || parsedRes.comprobanteText || "Constancia registrada en Guaraní",
        detalles: {
          estado: nueva?.estado || "Registrada",
          fecha: nueva?.fecha || new Date().toLocaleDateString("es-AR")
        }
      };
    } catch (err) {
      logger.error(`Error al solicitar constancia en Guaraní: ${err}`);
      throw err;
    }
  });
}

// Consulta el listado histórico de solicitudes de constancias sin emitir nuevas solicitudes
export async function getHistorialConstancias(
  carrera?: string,
  descargar = false
): Promise<SolicitudListadoItem[]> {
  return withGuaraniLock(async () => {
    await ensureCarreraActiva(carrera);
  const res = await guaraniFetch("/solicitudes");
  const raw = await readGuaraniText(res);
  const items: SolicitudListadoItem[] = parseSolicitudesListado(unwrapChulupiHtml(raw));

  if (descargar) {
    for (const it of items) {
      if (it.urlDescarga) {
        try {
          const downloadUrl = new URL(it.urlDescarga, CONFIG.GUARANI_BASE_URL).href;
          const u = new URL(downloadUrl);
          const pdfRes = await guaraniFetch(u.pathname + u.search);
          const pdfBuf = new Uint8Array(await pdfRes.arrayBuffer());
          if (pdfBuf.length > 50 && pdfBuf[0] === 0x25 && pdfBuf[1] === 0x50 && pdfBuf[2] === 0x44 && pdfBuf[3] === 0x46) {
            const safeName = `constancia_${(it.tipo || "solicitud").toLowerCase().replace(/[^a-z0-9]/g, "_")}_${it.id || Date.now()}.pdf`;
            const destPath = path.join(CONFIG.CERTIFICADOS_DIR, safeName);
            fs.mkdirSync(CONFIG.CERTIFICADOS_DIR, { recursive: true, mode: 0o700 });
            fs.writeFileSync(destPath, pdfBuf);
            it.rutaLocal = destPath;
          }
        } catch {}
      }
    }
  }

    return items;
  });
}
