# UCA MCP — Servidor Model Context Protocol para la Universidad Católica Argentina (UCA)

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.18.1-brightgreen.svg)](https://nodejs.org)
[![Licencia](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple.svg)](https://modelcontextprotocol.io)

Servidor **Model Context Protocol (MCP)** open source para conectar a tus asistentes de IA (Claude Desktop, Cursor, VS Code, Gemini, etc.) de forma segura y directa con las plataformas institucionales de la **Universidad Católica Argentina**:
- **EVA** (`eva.uca.edu.ar`)
- **SIU Guaraní** (`guarani.uca.edu.ar`)
- **Campus Autogestión** (`autogestion.uca.edu.ar`)

---

> **Privacidad y Tratamiento de Datos:**  
> - **Zero-Telemetry Propia:** El software opera 100% de manera local en tu computadora.  
> - Las credenciales y sesiones se cifran localmente en tu computadora y se resguardan en el **Llavero nativo del Sistema Operativo** (Windows DPAPI, macOS Keychain, Linux Secret Service).  
> - Ninguna contraseña se guarda en texto plano ni se expone al modelo de inteligencia artificial.  
> - Todas las subidas (entrega de tareas, respuestas a foros o inscripciones) están protegidas por una confirmación explícita del usuario (**Canal B / Elicitation**).  

---

## Instalación

> **Prerequisito:** Necesitás [Node.js](https://nodejs.org) **v20.18.1 o superior** instalado en tu computadora (salvo la opción `.mcpb` de Claude Desktop que no lo requiere).

Elegí tu cliente y seguí los pasos. El `uca-mcp login` abre el navegador para que te loguees con tu cuenta `@uca.edu.ar` y el 2FA — hacelo una sola vez.

---

### Claude Desktop

**Opción A — Sin terminal (recomendada):**

1. Descargá [`uca-mcp-1.0.7.mcpb`](https://github.com/santinohicke/UCA-MCP/releases) desde Releases.
2. En Claude Desktop andá a **Configuración → Extensiones** y arrastrá el archivo `.mcpb`.
3. Abrí un nuevo chat y escribí *"Iniciá sesión en UCA"*. Listo.

**Opción B — Desde terminal:**

```bash
npm install -g uca-mcp
uca-mcp login
uca-mcp setup claude
```

Reiniciá Claude Desktop y ya está conectado.

---

### Claude Code / Claude Code CLI

```bash
npm install -g uca-mcp
uca-mcp login
claude mcp add uca -- uca-mcp serve
```

---

### Antigravity / Antigravity CLI

```bash
npm install -g uca-mcp
uca-mcp login
agy mcp add uca -- uca-mcp serve
```

---

### Codex / Codex CLI

```bash
npm install -g uca-mcp
uca-mcp login
codex mcp add uca -- uca-mcp serve
```

---

### Cursor

```bash
npm install -g uca-mcp
uca-mcp login
uca-mcp setup cursor
```

Reiniciá Cursor y ya está conectado.

---

### VS Code

```bash
npm install -g uca-mcp
uca-mcp login
uca-mcp setup vscode
```

Reiniciá VS Code y ya está conectado.

---

### Hermes

```bash
npm install -g uca-mcp
uca-mcp login
hermes mcp add uca -- uca-mcp serve
```

---

### OpenClaw

```bash
npm install -g uca-mcp
uca-mcp login
openclaw mcp add uca --command "uca-mcp" --arg "serve"
```

---

### OpenCode

```bash
npm install -g uca-mcp
uca-mcp login
opencode mcp add uca -- uca-mcp serve
```

---

### Pi

```bash
npm install -g uca-mcp
uca-mcp login
pi mcp add uca -- uca-mcp serve
```

---

### Verificar que todo funcione (opcional)

Desde cualquier terminal, después de instalar y loguearte:

```bash
uca-mcp doctor
```

Comprueba Node.js, llavero del sistema, navegador, diálogo nativo y conectividad a EVA, SIU Guaraní y Campus.

> [!NOTE]
> **Transporte Exclusivo STDIO Local:** En esta versión (v1), **no cuenta con transporte HTTP/SSE remoto**, por lo que **no es compatible directamente con ChatGPT Web ni aplicaciones móviles** sin un túnel MCP local autogestionado.

---

## Catálogo de Herramientas MCP

| Herramienta | Plataforma | Tipo | Descripción |
| :--- | :--- | :--- | :--- |
| `uca_diagnosticar_sistema` | Local | Auth/Diag | Audita conectividad, validez del entorno gráfico y estado de la sesión cifrada. |
| `uca_iniciar_sesion` | Entra ID | Auth | Abre el navegador de forma no bloqueante para completar o renovar el login con 2FA. |
| `uca_resumen_semanal` | Compuesta | Lectura | Consulta en paralelo entregas próximas de EVA, avisos de foros y cursadas de Guaraní. |
| `eva_materias` | EVA | Lectura | Lista las aulas virtuales matriculadas y sus identificadores (`curso_id`). |
| `eva_contenido_curso` | EVA | Lectura | Lista las secciones, temas, recursos y tareas de un curso. |
| `eva_cronograma` | EVA | Lectura | Busca el cronograma o programa de la materia y extrae fechas de parciales, recuperatorios y entregas. |
| `eva_entregas_proximas` | EVA | Lectura | Consulta qué entregas vencen en los próximos días (ej. la semana que viene) y avisos de cátedra. |
| `eva_cuestionarios` | EVA | Lectura | Consulta cuestionarios, fechas de cierre, intentos y calificaciones en EVA. |
| `eva_tareas_y_notas` | EVA | Lectura | Consulta tareas pendientes, fechas límite y estado de calificaciones. |
| `eva_foros` | EVA | Lectura | Obtiene avisos de cátedra y discusiones recientes (con aviso de contenido no confiable). |
| `eva_hilo_foro` | EVA | Lectura | Obtiene el debate o hilo completo de un foro de cátedra con todas sus respuestas y mensajes. |
| `eva_buscar_materiales` | EVA | Lectura | Busca recursos y consignas por palabra clave en todas tus aulas. |
| `eva_leer_archivo` | EVA | Lectura | Descarga y extrae texto de PDFs y Office (.docx/.xlsx/.pptx) con allowlist estricta HTTPS y anti zip-bombs. |
| `eva_guardar_borrador_tarea` | EVA | Mutación | Sube un borrador editable de entrega tras validación y **aprobación física en Canal B**. |
| `eva_responder_foro` | EVA | Mutación | Publica una respuesta en un foro mostrando el texto completo tras **aprobación en Canal B**. |
| `guarani_progreso_carrera` | SIU Guaraní | Lectura | Responde exactamente cuántas materias te faltan para recibirte, cuáles estás cursando y el avance por año. |
| `guarani_plan_optimo` | SIU Guaraní | Lectura | Calcula el plan óptimo de cursada rankeando materias por cierre transitivo de correlativas y camino crítico. |
| `guarani_materias_habilitadas` | SIU Guaraní | Lectura | Computa qué materias pendientes podés cursar el próximo período según tu grafo de correlativas. |
| `guarani_estado_cursada` | SIU Guaraní | Lectura | Horarios, asistencias acumuladas, porcentaje de faltas y predictor de regularidad de cursadas activas. |
| `guarani_horario_semanal` | SIU Guaraní | Lectura | Horario semanal estructurado con materias, días, horarios, aulas y comisiones (admite filtro 'hoy'). |
| `guarani_historia_academica`| SIU Guaraní | Lectura | Analítico completo: finales aprobados, materias regulares, libro, folio y promedios. |
| `guarani_mesas_disponibles` | SIU Guaraní | Lectura | Mesas de examen final con fechas, turnos, tribunales y estado de inscripción. |
| `guarani_mis_inscripciones_examen` | SIU Guaraní | Lectura | Consulta inscripciones vigentes a examen final y actuaciones provisorias. |
| `guarani_encuestas_pendientes` | SIU Guaraní | Lectura | Verifica si hay encuestas docentes institucionales obligatorias o pendientes de responder. |
| `guarani_historial_constancias` | SIU Guaraní | Lectura | Consulta el historial de solicitudes de constancias y certificados emitidos con descarga de PDF. |
| `guarani_correlatividades_y_plan` | SIU Guaraní | Lectura | Plan interactivo, materias por año, correlativas para cursar/rendir e impacto a futuro. |
| `guarani_certificado_alumno_regular` | SIU Guaraní | Mutación | Emite y descarga formalmente en PDF la Constancia de Alumno Regular (o aprobadas/promedio) con código de validación institucional tras **aprobación en Canal B**. |
| `guarani_inscribir_examen` | SIU Guaraní | Mutación | Ciclo atómico en 2 fases con confirmación física en Canal B. **Nota:** La baja de examen no está disponible vía MCP (v1) y debe realizarse en [SIU Guaraní](https://guarani.uca.edu.ar). |
| `campus_aranceles_y_tramites`| Campus | Lectura | Consulta de cuotas al día/pendientes y estado de trámites administrativos (estricto read-only). |

---

## Seguridad y Arquitectura

1. **Blindaje de STDOUT (`src/silence-stdout.ts`)**: Todo log, advertencia o salida de procesos secundarios se redirige a `stderr`. El transporte JSON-RPC corre exclusivamente sobre `mcpStdoutStream`, garantizando que la trama no se corrompa jamás.
2. **Canal B Independiente y Elicitation**: Las acciones de mutación no pueden ser auto-aprobadas por el LLM ni por inyecciones de prompt. Se despliega una ventana modal nativa del sistema operativo (`WScript.Shell.Popup` en Windows, `osascript` en macOS, `zenity` / `kdialog` / `yad` en Linux) con botón *Cancelar* por defecto y timeout de 45 segundos (fail-closed). En entornos headless o donde las ventanas nativas no estén disponibles, conmuta de forma transparente a Canal A (formulario interactivo MCP Elicitation) sin falsos rechazos de usuario.
3. **Llavero Nativo y Cero Secretos en `argv`**: Las claves maestras se manejan mediante canal `stdin` (en Windows DPAPI, macOS Keychain mediante `security -i`, y Linux Secret Service vía `secret-tool` con soporte de `UCA_PASSPHRASE` y fallback degradado a `machine-id`), evitando que secretos aparezcan en `ps` o en variables de entorno. Asimismo, las cookies de sesión de Entra ID se alojan en el perfil persistente de navegador (`browser-profile/`), protegidas bajo el cifrado nativo de Chromium en el sistema operativo (DPAPI en Windows). En macOS y Linux, el aislamiento recae en los permisos de archivo locales del usuario del sistema operativo. El comando `uca-mcp logout` (o invocar `uca_iniciar_sesion` con `forzar_relogin: true`) purga este directorio y los certificados descargados por completo.
4. **Protección Anti-SSRF y Anti Zip-Bomb**:
   - Descargas restringidas exclusivamente a `https://eva.uca.edu.ar` bajo `/pluginfile.php` o `/mod/`.
   - Streaming de descarga con límite rígido de 25 MB.
   - Descompresión en streaming con `BoundedUnzipInflate` de `fflate` para abortar inmediatamente durante la descompresión si los bytes reales superan los 60 MB, neutralizando cabeceras falsificadas.
5. **Modelo de Amenazas y Límites de Seguridad del Sistema Operativo**:
   - Canal B y Elicitation previenen inyecciones de prompt indirectas, escalamiento de contexto o ejecución autónoma no autorizada de herramientas por parte del LLM.
   - **Límites de aislamiento del host:** Si un agente de IA o proceso secundario posee permisos de shell o ejecución arbitraria de comandos en el sistema operativo bajo la misma cuenta de usuario (mismo UID/SID), dicho proceso tiene acceso nativo al sistema de archivos local y podría leer las cookies de sesión, el llavero o los perfiles de navegador. Se recomienda ejecutar agentes con acceso a shell en entornos aislados o contenedores.

---

> Esta herramienta fue creada para estudiantes de la UCA y **no cuenta con patrocinio, aval, asociación ni relación formal con la Universidad Católica Argentina**.  

## Licencia

Este proyecto se distribuye bajo los términos de la Licencia **MIT**. Consultá el archivo [LICENSE](LICENSE) para más detalles.
