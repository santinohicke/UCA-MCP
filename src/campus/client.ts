import * as cheerio from "cheerio";
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
  if (s.includes("sin deuda") || s.includes("no adeuda") || s.includes("libre de deuda") || s.includes("al dia") || s.includes("al día")) {
    return "Pagado";
  }
  // Casos negativos o de deuda impaga primero para evitar que 'impago' o 'no pagado' coincidan con 'pag'
  if (s.includes("no pag") || s.includes("impag") || s.includes("deuda") || s.includes("a pagar")) {
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
  if (/\bal d[ií]a\b/i.test(s)) {
    return "Al día";
  }
  return "Desconocido";
}

// Consulta de aranceles y estado de trámites administrativos en Campus Autogestión (Estricto Read-Only)
export async function getArancelesYTramites(
  consulta: "todo" | "aranceles" | "tramites" = "todo"
): Promise<CampusInfo> {
  const result: CampusInfo = {
    aranceles: [],
    tramites: []
  };

  let arancelesError: unknown;
  let tramitesError: unknown;

  // 1. Aranceles
  if (consulta === "todo" || consulta === "aranceles") {
    try {
      const res = await campusFetch("/aranceles");
      const html = await res.text();
      if (html.includes("Acceso al Campus") && (html.includes("¡Te damos la bienvenida!") || html.includes("Ingresá con tu cuenta"))) {
        throw new CampusSessionExpiredError();
      }
      const $ = cheerio.load(html);

      // Intento de extracción desde __NEXT_DATA__ si la página es Next.js
      const nextDataScript = $("#__NEXT_DATA__").html();
      if (nextDataScript) {
        try {
          const nextData = JSON.parse(nextDataScript) as any;
          const pageProps = nextData.props?.pageProps;
          const candidateArray =
            pageProps?.aranceles ||
            pageProps?.cuotas ||
            pageProps?.deuda ||
            pageProps?.estadoCuenta?.cuotas ||
            pageProps?.data?.aranceles;
          if (Array.isArray(candidateArray)) {
            result.aranceles = candidateArray.map((c: any) => ({
              concepto: c.concepto || c.descripcion || "Cuota mensual",
              periodo: c.periodo || c.mes || "",
              monto: c.monto !== undefined ? String(c.monto) : undefined,
              fechaVencimiento: c.fechaVencimiento || c.vencimiento || undefined,
              estado: parseEstadoCuota(c.estado || c.situacion || "")
            }));
          }
        } catch {
          // Fallback a Cheerio
        }
      }

      if (result.aranceles.length === 0) {
        // Parsear filas de aranceles clasificando semánticamente las celdas
        $("table.aranceles tbody tr, tr.cuota, .item-arancel, table tbody tr").each((_, tr) => {
          const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
          if (cells.length >= 3) {
            const concepto = cells[0] || "Cuota mensual";
            const periodo = cells[1] || "";
            let monto: string | undefined;
            let vencimiento: string | undefined;
            let estadoRaw = "";

            for (let i = 2; i < cells.length; i++) {
              const val = cells[i];
              if (val.includes("$") || /^\d{1,3}(?:\.\d{3})*(?:,\d{2})?$/.test(val)) {
                if (!monto) monto = val;
              } else if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(val)) {
                if (!vencimiento) vencimiento = val;
              } else if (/pag|pend|venc|\bal d[ií]a\b|impag|deud/i.test(val)) {
                if (!estadoRaw) estadoRaw = val;
              }
            }

            if (!estadoRaw && cells.length >= 4) {
              estadoRaw = cells[cells.length - 1];
            }
            if (!monto && cells.length >= 3) {
              monto = cells[2];
            }
            if (!vencimiento && cells.length >= 4) {
              vencimiento = cells[3];
            }

            result.aranceles.push({
              concepto,
              periodo,
              monto,
              fechaVencimiento: vencimiento,
              estado: parseEstadoCuota(estadoRaw)
            });
          }
        });
      }

      // Si no se parseó ninguna cuota, verificar que exista un marcador inequívoco en el contenido principal
      if (result.aranceles.length === 0) {
        const $clean = cheerio.load(html);
        $clean("script, style, noscript, nav, header, footer, select, option, form").remove();
        const mainText =
          $clean("main, #main-content, .content, #content, [role='main']").text() ||
          $clean("body").text();
        const lowerMain = mainText.toLowerCase().replace(/\s+/g, " ");

        const hasExplicitZeroDebtMarker =
          /no\s+(?:se\s+)?registra\s+deudas?|no\s+adeuda|sin\s+deuda|no\s+posee\s+cuotas\s+pendientes|no\s+presenta\s+saldo|saldo\s+total(?:\s+de\s+la\s+deuda)?(?:\s+al\s+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})?\s*(?:\$\s*)?0[,.]00/i.test(
            lowerMain
          );

        if (!hasExplicitZeroDebtMarker) {
          throw new Error(
            "No se pudieron identificar registros de aranceles ni un marcador explícito de 'sin deuda' en Campus Autogestión (formato de página no reconocido). Por seguridad patrimonial, consultá directamente en https://autogestion.uca.edu.ar."
          );
        }

        result.aranceles.push({
          concepto: "Cuenta corriente arancelaria",
          periodo: "Al día",
          monto: "$ 0,00",
          estado: "Al día"
        });
      }
      const conDeuda = result.aranceles.some((a) => a.estado === "Pendiente" || a.estado === "Vencido");
      const hayDesconocidas = result.aranceles.some((a) => a.estado === "Desconocido");
      result.estadoAranceles = conDeuda
        ? "Con deuda pendiente"
        : hayDesconocidas
          ? "No se pudo determinar con certeza, verificá en Autogestión"
          : "Al día";
    } catch (err) {
      logger.error(`No se pudieron obtener aranceles en Campus Autogestión: ${err}`);
      arancelesError = err;
      if (consulta === "aranceles") throw err;
      result.estadoAranceles = "Error al consultar aranceles";
      result.errores = {
        ...result.errores,
        aranceles: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // 2. Trámites
  if (consulta === "todo" || consulta === "tramites") {
    try {
      let res: Response;
      try {
        res = await campusFetch("/mis-tramites");
        if (res.status === 404) res = await campusFetch("/tramites");
      } catch {
        res = await campusFetch("/tramites");
      }
      const html = await res.text();
      if (html.includes("Acceso al Campus") && (html.includes("¡Te damos la bienvenida!") || html.includes("Ingresá con tu cuenta"))) {
        throw new CampusSessionExpiredError();
      }
      const $ = cheerio.load(html);

      const nextDataScript = $("#__NEXT_DATA__").html();
      if (nextDataScript) {
        try {
          const nextData = JSON.parse(nextDataScript) as {
            props?: { pageProps?: { tramites?: TramiteInfo[] } };
          };
          const tramites = nextData.props?.pageProps?.tramites;
          if (Array.isArray(tramites)) {
            result.tramites = tramites;
          }
        } catch {
          // Fallback a Cheerio
        }
      }

      if (result.tramites.length === 0) {
        $("table.tramites tbody tr, tr.tramite, .item-tramite").each((idx, tr) => {
          const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
          if (cells.length >= 2) {
            result.tramites.push({
              id: `tramite-${idx + 1}`,
              titulo: cells[0] || "Trámite administrativo",
              fechaInicio: cells[1] || "Reciente",
              estado: cells[2] || "En proceso",
              detalle: cells[3] || undefined
            });
          }
        });
      }

      // Si no se parseó ningún trámite, verificar que exista un marcador inequívoco en el contenido principal
      if (result.tramites.length === 0) {
        const $clean = cheerio.load(html);
        $clean("script, style, noscript, nav, header, footer, select, option, form").remove();
        const mainText =
          $clean("main, #main-content, .content, #content, [role='main']").text() ||
          $clean("body").text();
        const lowerMain = mainText.toLowerCase().replace(/\s+/g, " ");

        const hasExplicitZeroTramites =
          lowerMain.includes("no registra trámites") ||
          lowerMain.includes("sin trámites") ||
          lowerMain.includes("no posee trámites iniciados") ||
          lowerMain.includes("no se encontraron trámites");

        if (!hasExplicitZeroTramites) {
          throw new Error(
            "No se pudieron identificar trámites ni un indicador explícito de 'sin trámites' en Campus Autogestión (formato de página no reconocido). Consultá directamente en https://autogestion.uca.edu.ar."
          );
        }
      }
    } catch (err) {
      logger.error(`No se pudieron obtener trámites en Campus Autogestión: ${err}`);
      tramitesError = err;
      if (consulta === "tramites") throw err;
      result.errores = {
        ...result.errores,
        tramites: err instanceof Error ? err.message : String(err)
      };
    }
  }

  if (consulta === "todo" && arancelesError && tramitesError) {
    throw arancelesError;
  }

  return result;
}
