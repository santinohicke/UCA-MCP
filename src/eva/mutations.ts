import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { evaFetch, evaAjaxRpc } from "../shared/http.js";
import { showNativeConfirmation, validateUploadFile, pickNativeFile, sanitizeDialogText } from "../shared/native-confirm.js";
import { clearEvaCache } from "./client.js";
import { logger } from "../shared/logger.js";

// Escapa entidades HTML críticas para prevenir inyección de etiquetas arbitrarias en Moodle
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface GuardarBorradorParams {
  cmid: number;
  rutaArchivo?: string;
  textoEnLinea?: string;
}

export interface MutationResult {
  exito: boolean;
  aprobado?: boolean;
  instruccion?: string;
  mensaje: string;
  detalles?: Record<string, unknown>;
}

// Helper puro para serializar inputs del formulario de Moodle filtrando botones, cancelaciones y checkboxes no marcados
export function buildSaveSubmissionFormData(
  formHtml: string,
  cmid: number,
  sesskey?: string,
  draftItemMatch?: string,
  textoEnLinea?: string
): URLSearchParams {
  const $form = cheerio.load(formHtml);
  const postBody = new URLSearchParams();

  $form("input, select, textarea").each((_, el) => {
    const $el = $form(el);
    const name = $el.attr("name");
    if (!name) return;

    const type = ($el.attr("type") || "").toLowerCase();

    // Excluir botones de submit, reset y botón de cancelación (Moodle interpreta cancelbutton como cancelar)
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return;
    if (name === "cancelbutton" || name === "cancel") return;

    // Checkboxes y radios: solo enviar si están seleccionados
    if ((type === "checkbox" || type === "radio") && !$el.is(":checked")) return;

    // files_filemanager se setea explícitamente abajo con draftItemMatch
    if (name === "files_filemanager") return;

    // onlinetext_editor: preservar [itemid] siempre; si se proporciona textoEnLinea se sobreescriben [text] y [format] abajo
    if (name.startsWith("onlinetext_editor")) {
      if (name === "onlinetext_editor[itemid]" || !textoEnLinea) {
        postBody.append(name, $el.val()?.toString() || "");
      }
      return;
    }

    postBody.append(name, $el.val()?.toString() || "");
  });

  postBody.set("id", String(cmid));
  postBody.set("action", "savesubmission");
  if (sesskey) postBody.set("sesskey", sesskey);
  postBody.set("_qf__mod_assign_submission_form", "1");
  postBody.set("submitbutton", "Guardar cambios");

  if (draftItemMatch) {
    postBody.set("files_filemanager", draftItemMatch);
  }
  if (textoEnLinea) {
    const formattedHtml = textoEnLinea
      .replace(/\r\n|\r/g, "\n")
      .split("\n")
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("");
    postBody.set("onlinetext_editor[text]", formattedHtml);
    postBody.set("onlinetext_editor[format]", "1");
  }

  return postBody;
}

// Helper puro para identificar postid padre, asunto y contexto en discusión de foro
export function extractForumReplyContext(
  discHtml: string,
  discusionId?: number
): {
  parentPostId: number;
  replySubject: string;
  nombreForo: string;
  autorOriginal: string;
} | null {
  const $disc = cheerio.load(discHtml);
  const matchPostId =
    discHtml.match(/data-post-id="(\d+)"/i) ||
    discHtml.match(/id="p(\d+)"/i) ||
    discHtml.match(/[?&]reply=(\d+)/i);

  if (!matchPostId) {
    return null;
  }

  const parentPostId = parseInt(matchPostId[1], 10);
  const matchSubject =
    discHtml.match(/data-reply-subject="([^"]+)"/i) ||
    $disc(".discussionname, h3, h2").first().text().trim();

  const baseSubject =
    typeof matchSubject === "string" ? matchSubject : matchSubject?.[1] || `Discusión ${discusionId ? `#${discusionId}` : ""}`;
  const replySubject = baseSubject.toLowerCase().startsWith("re:") ? baseSubject : `Re: ${baseSubject}`;

  const nombreForo =
    $disc(".breadcrumb li:nth-last-child(2) a").text().trim() ||
    $disc(".breadcrumb").text().replace(/\s+/g, " ").trim() ||
    "Foro de cátedra";
  const autorOriginal =
    $disc(".forumpost .author, .author a").first().text().replace(/\s+/g, " ").trim() ||
    "Cátedra";

  return { parentPostId, replySubject, nombreForo, autorOriginal };
}

// 1. Guarda un borrador de tarea tras inspección de estado y confirmación física en Canal B
export async function guardarBorradorTarea(
  params: GuardarBorradorParams,
  onProgress?: (msg: string, pct?: number) => Promise<void> | void
): Promise<MutationResult> {
  let { cmid, rutaArchivo, textoEnLinea } = params;

  if (rutaArchivo === "picker" || rutaArchivo === "dialog") {
    await onProgress?.("Abriendo selector nativo de archivos en el sistema...");
    const picked = await pickNativeFile();
    if (!picked) {
      throw new Error("No se seleccionó ningún archivo en el selector nativo.");
    }
    rutaArchivo = picked;
  }

  if (!rutaArchivo && !textoEnLinea) {
    throw new Error("Debés especificar al menos 'rutaArchivo' o 'textoEnLinea' para guardar el borrador.");
  }

  await onProgress?.("Inspeccionando estado de la tarea en EVA Moodle...");
  // 1. Inspeccionar estado de la tarea en Moodle antes de pedir confirmación
  const viewRes = await evaFetch(`/mod/assign/view.php?id=${cmid}`);
  const viewHtml = await viewRes.text();
  const $view = cheerio.load(viewHtml);

  // Extraer nombres legibles para que el usuario entienda qué está autorizando
  const nombreTarea =
    $view("h1, h2, .page-header-headings h1").first().text().replace(/\s+/g, " ").trim() ||
    `Tarea cmid #${cmid}`;
  const nombreCurso =
    $view(".breadcrumb li:nth-last-child(2) a").text().trim() ||
    $view(".breadcrumb").text().replace(/\s+/g, " ").trim() ||
    "Curso Moodle";
  const fechaVencimiento =
    $view("tr:contains('Fecha de entrega'), tr:contains('Due date')").find("td").first().text().trim() ||
    undefined;

  // Límite estricto de texto para garantizar que quepa completo y sin truncar en el diálogo (máx 350)
  if (textoEnLinea && textoEnLinea.length > 350) {
    throw new Error(
      `El texto en línea (${textoEnLinea.length} caracteres) supera el límite máximo auditable en pantalla (350 caracteres). Redactalo de forma más breve para poder verificarlo en su totalidad.`
    );
  }

  // Rechazar si el texto contiene caracteres invisibles o de control que el diálogo eliminaría (what-you-see ≠ what-you-send)
  let textoClean: string | undefined;
  if (textoEnLinea) {
    const textoNormalized = textoEnLinea.replace(/\r\n|\r/g, "\n");
    textoClean = sanitizeDialogText(textoNormalized, 350, true);
    if (textoClean !== textoNormalized) {
      throw new Error(
        "El texto en línea contiene caracteres invisibles o de control no permitidos."
      );
    }
  }

  // Verificar si la tarea permite entregas / edición
  const puedeEditar = viewHtml.includes("action=editsubmission") || viewHtml.includes("action=editprevioussubmission");
  const noAceptaEntregas =
    viewHtml.includes("No se aceptan entregas") ||
    viewHtml.includes("La fecha límite ha pasado") ||
    viewHtml.includes("Esta tarea no acepta entregas");

  if (noAceptaEntregas && !puedeEditar) {
    throw new Error(`La tarea '${nombreTarea}' (${nombreCurso}) se encuentra cerrada y no permite entregas ni modificaciones.`);
  }

  // Comprobar si ya existe una entrega previa
  const estadoEntregaTexto = $view("table.generaltable").text();
  const tieneEntregaPrevia =
    estadoEntregaTexto.includes("Enviado para calificar") ||
    estadoEntregaTexto.includes("Archivos enviados") ||
    $view(".submissionstatussubmitted").length > 0;

  // 2. Obtener el formulario de edición de antemano para validar draftItemId y estado antes del diálogo
  const formRes = await evaFetch(`/mod/assign/view.php?id=${cmid}&action=editsubmission`);
  const formHtml = await formRes.text();
  const $form = cheerio.load(formHtml);

  const sesskey =
    $form('input[name="sesskey"]').val()?.toString() ||
    /sesskey["']?\s*:\s*["']([^"']+)["']/i.exec(formHtml)?.[1] ||
    "";

  const draftItemMatch =
    $form('input[name="files_filemanager"]').val()?.toString() ||
    /name="files_filemanager"\s+value="(\d+)"/i.exec(formHtml)?.[1] ||
    /itemid["']?\s*:\s*(\d+)/i.exec(formHtml)?.[1];

  if (rutaArchivo && !draftItemMatch) {
    throw new Error(
      `No se pudo obtener el identificador de borrador (draftItemId) de Moodle para adjuntar el archivo en la tarea #${cmid}.`
    );
  }

  // 3. Determinar si la tarea es entrega definitiva mediante submissiondrafts (API oficial)
  let esEntregaDefinitiva = false;
  let entregaDefinitivaDeterminada = false;
  let targetAssignId: number | undefined;
  try {
    const courseLink = $view(".breadcrumb a[href*='/course/view.php']").attr("href") || "";
    const courseIdMatch = /[?&]id=(\d+)/.exec(courseLink);
    const courseId = courseIdMatch ? parseInt(courseIdMatch[1], 10) : undefined;
    const assignsData = await evaAjaxRpc<{
      courses?: Array<{ assignments?: Array<{ id: number; cmid: number; submissiondrafts?: number }> }>;
    }>("mod_assign_get_assignments", courseId ? { courseids: [courseId] } : {});
    const allAssignments = assignsData?.courses?.flatMap((c) => c.assignments || []) || [];
    const matchedAssign = allAssignments.find((a) => a.cmid === cmid);
    if (matchedAssign) {
      targetAssignId = matchedAssign.id;
      if (matchedAssign.submissiondrafts !== undefined) {
        esEntregaDefinitiva = matchedAssign.submissiondrafts === 0;
        entregaDefinitivaDeterminada = true;
      }
    }
  } catch {
    // Si la llamada RPC no está disponible, se indicará en el diálogo que el tipo de entrega no se pudo determinar
  }

  let validatedFilePath: string | undefined;
  let expectedSha256: string | undefined;
  let fileDetails = "Sin archivo adjunto";
  if (rutaArchivo) {
    const fileVal = validateUploadFile(rutaArchivo);
    if (!fileVal.valid) {
      throw new Error(`Validación de archivo fallida: ${fileVal.reason}`);
    }
    validatedFilePath = fileVal.realPath || rutaArchivo;
    expectedSha256 = fileVal.sha256;
    const sizeKb = Math.round((fileVal.sizeBytes || 0) / 1024);
    const shortHash = fileVal.sha256 ? fileVal.sha256.slice(0, 16) : "N/A";
    const fileName = path.basename(validatedFilePath);
    fileDetails = `Archivo: ${fileName} (${sizeKb} KB, SHA-256: ${shortHash}...)`;
  }

  let advertencia = "";
  if (tieneEntregaPrevia) {
    advertencia += "\n⚠️ ADVERTENCIA: Esta tarea ya posee una entrega previa. Guardar reemplazará los archivos/textos anteriores.\n";
  }
  if (esEntregaDefinitiva) {
    advertencia += "\n⚠️ ATENCIÓN: Esta tarea no requiere confirmación de entrega separada. Guardar constituirá la ENTREGA DEFINITIVA.\n";
  } else if (entregaDefinitivaDeterminada) {
    advertencia += "\nNota: Esta acción guarda un borrador. La entrega definitiva requerirá confirmación posterior en EVA.\n";
  } else {
    advertencia += "\n⚠️ AVISO: No se pudo verificar si la tarea exige confirmación de entrega o si el guardado constituye entrega definitiva. Verificá tu entrega en EVA tras guardar.\n";
  }

  const detalleDialogo = `Tarea: ${nombreTarea}\nCurso: ${nombreCurso}\n${fechaVencimiento ? `Vencimiento: ${fechaVencimiento}\n` : ""}${fileDetails}\nTexto: ${textoClean ? `"${textoClean}"` : "Sin texto en línea"}${advertencia}`;

  if (detalleDialogo.length > 800) {
    throw new Error(
      `El detalle consolidado de la tarea (${detalleDialogo.length} caracteres) excede el límite máximo auditable en pantalla (800 caracteres). Redactá un texto en línea más breve.`
    );
  }

  // Canal B: Diálogo modal nativo obligatorio antes de cualquier mutación
  const aprobado = await showNativeConfirmation(
    {
      titulo: esEntregaDefinitiva
        ? "Confirmar entrega definitiva - EVA UCA"
        : !entregaDefinitivaDeterminada
        ? "Confirmar entrega / borrador - EVA UCA"
        : "Confirmar borrador de tarea - EVA UCA",
      accion: esEntregaDefinitiva
        ? "Guardar entrega definitiva en EVA"
        : !entregaDefinitivaDeterminada
        ? "Guardar archivo/texto en EVA (estado de borrador no verificado)"
        : "Guardar borrador de entrega (Modo editable)",
      entidad: `${nombreTarea} (${nombreCurso})`,
      detalle: detalleDialogo
    },
    (tick = 1) => onProgress?.(`Esperando confirmación física en Canal B... (${tick * 4}s)`, 50 + Math.min(45, tick * 3))
  );

  if (!aprobado) {
    logger.info(`Guardado para cmid ${cmid} cancelado por el usuario en Canal B`);
    return {
      exito: false,
      aprobado: false,
      mensaje: "Operación cancelada por el usuario en el diálogo de autorización.",
      instruccion: "El usuario denegó explícitamente la confirmación para guardar la entrega. NO vuelvas a intentar guardar esta tarea ni sugieras rodeos a menos que el usuario te lo solicite expresamente."
    };
  }

  try {
    await onProgress?.("Subiendo archivo y guardando borrador en EVA Moodle...");
    // Subir archivo a la zona de draft de Moodle si se especificó rutaArchivo
    if (rutaArchivo && draftItemMatch) {
      const targetFile = validatedFilePath || rutaArchivo;
      const fileBytes = fs.readFileSync(targetFile);

      // Re-verificación estricta de hash SHA-256 para prevenir ataques TOCTOU tras la confirmación
      if (expectedSha256) {
        const postSha256 = crypto.createHash("sha256").update(fileBytes).digest("hex");
        if (postSha256 !== expectedSha256) {
          throw new Error(
            "El archivo a subir fue modificado en disco tras la autorización del usuario. Operación abortada por seguridad (TOCTOU)."
          );
        }
      }

      const fileName = path.basename(targetFile);
      const safeFileName = fileName.replace(/["\r\n]/g, "_");
      const boundary = "----MoodleUploadBoundary" + Date.now();

      // Extraer parámetros contextuales del repositorio en formHtml si están presentes
      const repoIdMatch = /["']repo_id["']\s*:\s*(\d+)/i.exec(formHtml)?.[1] || "4";
      const ctxIdMatch =
        /["']contextid["']\s*:\s*(\d+)/i.exec(formHtml)?.[1] ||
        $form('input[name="contextid"]').val()?.toString() ||
        "";
      const clientIdMatch =
        /["']client_id["']\s*:\s*["']([^"']+)["']/i.exec(formHtml)?.[1] ||
        $form('input[name="client_id"]').val()?.toString() ||
        "";

      const bodyParts: (Buffer | string)[] = [
        `--${boundary}\r\nContent-Disposition: form-data; name="repo_id"\r\n\r\n${repoIdMatch}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="itemid"\r\n\r\n${draftItemMatch}\r\n`,
        ctxIdMatch ? `--${boundary}\r\nContent-Disposition: form-data; name="ctx_id"\r\n\r\n${ctxIdMatch}\r\n` : "",
        clientIdMatch ? `--${boundary}\r\nContent-Disposition: form-data; name="client_id"\r\n\r\n${clientIdMatch}\r\n` : "",
        sesskey ? `--${boundary}\r\nContent-Disposition: form-data; name="sesskey"\r\n\r\n${sesskey}\r\n` : "",
        `--${boundary}\r\nContent-Disposition: form-data; name="repo_upload_file"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        fileBytes,
        `\r\n--${boundary}--\r\n`
      ];

      const multipartBuffer = Buffer.concat(
        bodyParts.filter(Boolean).map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p))
      );

      const upRes = await evaFetch("/repository/repository_ajax.php?action=upload", {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`
        },
        body: multipartBuffer
      });

      if (!upRes.ok) {
        throw new Error(`Error HTTP ${upRes.status} al subir archivo al repositorio draft de Moodle.`);
      }

      // Validar si Moodle devolvió error en JSON aún con HTTP 200
      try {
        const upJson = (await upRes.clone().json()) as any;
        if (upJson && upJson.error) {
          throw new Error(`Moodle rechazó la subida del archivo: ${upJson.error}`);
        }
      } catch (e: any) {
        if (e.message?.includes("Moodle rechazó")) throw e;
      }
    }

    // Serializar inputs del formulario de Moodle mediante helper puro compartido
    const postBody = buildSaveSubmissionFormData(formHtml, cmid, sesskey, draftItemMatch, textoClean || textoEnLinea);

    const saveRes = await evaFetch(`/mod/assign/view.php?id=${cmid}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: postBody.toString()
    });

    if (!saveRes.ok) {
      throw new Error(`Error HTTP ${saveRes.status} al guardar la entrega en Moodle.`);
    }

    // Si Moodle rechaza el guardado por validación, re-renderiza el formulario con HTTP 200 en saveRes
    const saveHtml = await saveRes.text();
    const $save = cheerio.load(saveHtml);
    const saveErr = $save(".alert-danger, .errormessage, .notifyproblem, .invalid-feedback, .form-control-feedback").text().trim();
    if (saveErr || saveHtml.includes("_qf__mod_assign_submission_form")) {
      throw new Error(`Moodle rechazó el guardado de la entrega: ${saveErr || "el formulario de entrega volvió a mostrarse con errores de validación"}`);
    }

    // Verificación post-guardado
    const checkRes = await evaFetch(`/mod/assign/view.php?id=${cmid}`);
    const checkHtml = await checkRes.text();
    const $check = cheerio.load(checkHtml);

    const hasError = $check(".alert-danger, .errormessage, .notifyproblem").text().trim();
    if (hasError) {
      throw new Error(`Moodle rechazó el guardado de la entrega: ${hasError}`);
    }

    if (rutaArchivo) {
      const baseName = path.basename(validatedFilePath || rutaArchivo);
      let detectedInApi = false;
      if (targetAssignId) {
        try {
          const statusRes = await evaAjaxRpc<{
            lastattempt?: {
              submission?: {
                plugins?: Array<{
                  fileareas?: Array<{
                    files?: Array<{ filename?: string }>;
                  }>;
                }>;
              };
            };
          }>("mod_assign_get_submission_status", { assignid: targetAssignId });

          const apiFiles = statusRes?.lastattempt?.submission?.plugins
            ?.flatMap((p) => p.fileareas || [])
            ?.flatMap((fa) => fa.files || [])
            ?.map((f) => f.filename) || [];

          if (apiFiles.includes(baseName)) {
            detectedInApi = true;
          }
        } catch {
          // Fallback a detección en HTML
        }
      }

      let detectedInHtml = false;
      if (checkHtml.includes(baseName) || checkHtml.includes(encodeURIComponent(baseName))) {
        detectedInHtml = true;
      } else {
        const $check = cheerio.load(checkHtml);
        detectedInHtml = $check.text().includes(baseName);
      }

      if (!detectedInApi && !detectedInHtml) {
        logger.warn(`El nombre de archivo ${baseName} no se detectó ni en mod_assign_get_submission_status ni en el HTML post-guardado.`);
        return {
          exito: false,
          aprobado: true,
          mensaje: `Estado desconocido: La solicitud de guardado de entrega fue enviada pero el archivo '${baseName}' no pudo ser verificado ni en la API ni en el resumen de la tarea #${cmid}. NO reintentes el guardado de inmediato para evitar sobrescrituras. Verificá en el aula virtual: https://eva.uca.edu.ar/mod/assign/view.php?id=${cmid}`,
          instruccion: "NO reintentes inmediatamente. Verificá en EVA Moodle antes de volver a enviar.",
          detalles: {
            cmid,
            archivo: baseName,
            entregaDefinitiva: esEntregaDefinitiva
          }
        };
      }
    }

    logger.audit("borrador_tarea_guardado", {
      cmid,
      archivo: rutaArchivo ? path.basename(rutaArchivo) : null,
      entregaDefinitiva: esEntregaDefinitiva
    });

    clearEvaCache();

    return {
      exito: true,
      mensaje: esEntregaDefinitiva
        ? `Entrega guardada exitosamente en EVA Moodle para la tarea #${cmid} (entrega definitiva registrada).`
        : `Borrador guardado exitosamente en EVA Moodle para la tarea #${cmid}.`,
      detalles: {
        cmid,
        archivo: rutaArchivo ? path.basename(rutaArchivo) : null,
        textoEnLineaPresente: Boolean(textoEnLinea),
        entregaDefinitiva: esEntregaDefinitiva
      }
    };
  } catch (err) {
    logger.error(`Error al guardar borrador en Moodle cmid ${cmid}`, err);
    throw err;
  }
}

// 2. Publica un mensaje en un foro de cátedra tras confirmación física en Canal B
export async function responderForo(
  discusionId: number,
  mensaje: string,
  onProgress?: (msg: string, pct?: number) => Promise<void> | void
): Promise<MutationResult> {
  const msgTrimmed = mensaje.trim();
  if (!msgTrimmed) {
    throw new Error("El mensaje a publicar en el foro no puede estar vacío.");
  }

  if (msgTrimmed.length > 350) {
    throw new Error(
      `El mensaje (${msgTrimmed.length} caracteres) supera el límite máximo auditable en pantalla (350 caracteres). Redactalo de forma más breve para que pueda ser verificado íntegramente en el diálogo de autorización.`
    );
  }

  // Rechazar si el mensaje contiene caracteres invisibles o de control que el diálogo eliminaría (what-you-see ≠ what-you-send)
  const msgNormalized = msgTrimmed.replace(/\r\n|\r/g, "\n");
  const msgClean = sanitizeDialogText(msgNormalized, 350, true);
  if (msgClean !== msgNormalized) {
    throw new Error("El mensaje contiene caracteres invisibles o de control no permitidos.");
  }

  await onProgress?.("Identificando hilo de discusión en EVA Moodle...");
  // Obtener la discusión para extraer el postid del mensaje principal, el asunto y nombres legibles
  const discRes = await evaFetch(`/mod/forum/discuss.php?d=${discusionId}`);
  const discHtml = await discRes.text();

  const forumCtx = extractForumReplyContext(discHtml, discusionId);
  if (!forumCtx) {
    throw new Error(
      `No se pudo identificar el postid del mensaje principal en la discusión #${discusionId} para responder.`
    );
  }

  const { parentPostId, replySubject, nombreForo, autorOriginal } = forumCtx;
  const baseSubject = replySubject.startsWith("Re: ") ? replySubject.slice(4) : replySubject;

  const detalleDialogo = `Foro: ${nombreForo}\nDocente/Autor original: ${autorOriginal}\nAsunto: ${replySubject}\n\nMensaje a publicar:\n"${msgClean}"\n\nEste mensaje será visible por todos los alumnos y docentes del curso.`;

  if (detalleDialogo.length > 800) {
    throw new Error(
      `El detalle consolidado de la respuesta (${detalleDialogo.length} caracteres) excede el límite máximo auditable en pantalla (800 caracteres). Redactá un mensaje más breve.`
    );
  }

  // Canal B: Diálogo modal nativo mostrando el contenido exacto y completo a publicar (sin truncado)
  const aprobado = await showNativeConfirmation(
    {
      titulo: "Confirmar respuesta en foro - EVA UCA",
      accion: "Publicar mensaje en foro institucional",
      entidad: `"${baseSubject}" (${nombreForo})`,
      detalle: detalleDialogo
    },
    (tick = 1) => onProgress?.(`Esperando confirmación física en Canal B... (${tick * 4}s)`, 50 + Math.min(45, tick * 3))
  );

  if (!aprobado) {
    logger.info(`Publicación en foro #${discusionId} cancelada por el usuario en Canal B`);
    return {
      exito: false,
      aprobado: false,
      mensaje: "Publicación cancelada por el usuario en el diálogo de autorización.",
      instruccion: "El usuario denegó explícitamente la confirmación para publicar en el foro. NO vuelvas a intentar enviar este mensaje a menos que el usuario te lo pida expresamente."
    };
  }

  try {
    const formattedMsg = msgClean
      .split("\n")
      .map((l) => `<p>${escapeHtml(l)}</p>`)
      .join("");

    const res = await evaAjaxRpc<{ postid?: number }>("mod_forum_add_discussion_post", {
      postid: parentPostId,
      subject: replySubject,
      message: formattedMsg,
      options: []
    });

    logger.audit("foro_respuesta_publicada", { discusionId, parentPostId, postid: res?.postid });

    return {
      exito: true,
      mensaje: `Mensaje publicado exitosamente en el foro de la discusión #${discusionId}.`,
      detalles: {
        discusionId,
        parentPostId,
        postId: res?.postid,
        asunto: replySubject
      }
    };
  } catch (err) {
    logger.error(`Error al publicar respuesta en foro discusionId ${discusionId}`, err);
    throw err;
  }
}
