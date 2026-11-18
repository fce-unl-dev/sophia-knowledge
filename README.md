# Luca — Base de Conocimiento (FCE-UNL)

Este repositorio contiene la **base de conocimiento oficial** de **Luca**, el asistente virtual de la Facultad de Ciencias Económicas de la Universidad Nacional del Litoral (FCE-UNL).

El nombre técnico del repositorio sigue siendo `sophia-knowledge`; el cambio de marca no modifica sus URLs ni contratos de integración.

Aquí reside la **única fuente de verdad** que Luca consulta en tiempo real para responder a los usuarios por chat web y WhatsApp. Cada archivo aquí guardado ha sido redactado, verificado y aprobado por personas de la institución.

---

## 📖 Sección 1: Para Editores y Personal de la Facultad (No Técnicos)

Si sos coordinador, administrativo o responsable de un área en la FCE y necesitás actualizar la información que Luca utiliza para responder (por ejemplo, corregir la fecha de un trámite, agregar un nuevo curso o cambiar un número de contacto), esta sección es para vos.

### ¿Cómo funciona la base de conocimiento?
A diferencia de otros sistemas que leen directamente la web (lo que a veces genera que Luca responda con información vieja o confusa de años anteriores), Luca lee **exclusivamente** los archivos de este repositorio. Si la información no está escrita aquí de forma clara, Luca dirá honestamente que no la sabe y derivará la consulta a un operador humano.

### ¿Cómo se mantiene actualizada la información? (3 vías)

La base de conocimiento de Luca se actualiza combinando **sincronización automática** y **control humano**, según el origen de cada dato:

1. **Sincronización automática con el CRM de Posgrado (cada 6 horas):**
   - El sistema consulta automáticamente los endpoints oficiales del CRM (`propuestas` y `cursos`).
   - Actualiza directamente en los archivos de `posgrados/`, `diplomaturas/`, `compartidos/` y `cursos-posgrado/` el estado de inscripción (*Abierta* / *Cerrada*), la fecha límite y la respuesta frecuente oficial (FAQ) cargada en el CRM.
   - Si en el CRM se da de alta una carrera o curso nuevo que todavía no tiene archivo o ruta asignada en Luca, el sistema frena preventivamente y avisa al equipo técnico para vincularlo.

2. **Carpeta institucional de Google Drive (1 vez por día, con revisión humana):**
   - Las áreas de la facultad suben o actualizan documentos y planillas (por ejemplo, la planilla `Info costos carrera para la IA` con los aranceles de posgrado, reglamentos o resoluciones de planes de estudio) en la carpeta compartida de Google Drive.
   - Todos los días el sistema lee Drive, transcribe las novedades a la carpeta `complementos/` y abre una **Propuesta de Cambio (Pull Request)** con la etiqueta `needs-review`.
   - **Importante:** Por seguridad institucional, los cambios de Drive **nunca se publican solos**. Requieren que un responsable apruebe la propuesta (desde el panel `/admin/` de Luca o desde GitHub). Para saber cómo subir o actualizar archivos en Drive sin errores, consultá la 👉 **[Guía de Carga en Google Drive](docs/GUIA_CARGA_DRIVE.md)**.

3. **Edición directa de páginas y fichas (con revisión según impacto):**
   - Los scrapers del sitio web oficial (`fce.unl.edu.ar`) detectan cambios en páginas de carreras, cursos o estudiantes y proponen la actualización automáticamente.
   - Si sos responsable de un área y querés editar un texto directamente en GitHub o desde el panel `/admin/`, seguí la 👉 **[Guía de Operación y Redacción para Editores](docs/GUIA_EDITORES.md)**.
   - Una vez aprobado cualquier cambio en la rama principal (`main`), Luca actualiza su memoria automáticamente en menos de **1 hora** (o en el acto si se fuerza el refresco desde el panel).

---

## 🛠️ Sección 2: Para Desarrolladores y Colaboradores Técnicos (Technical Reference)

Esta sección describe la arquitectura de la base de conocimiento, su integración con el agente y los mecanismos de validación automatizados.

### Consumo en Runtime
El agente de producción (`agente-sophia-v2`) consume este repositorio de manera dinámica mediante **enrutamiento por sectores** (`KB_ROUTING_ENABLED=true`):
1. Al iniciar o expirar el TTL de la caché (1 hora por defecto), el agente descarga [indice.json](indice.json) y [routing_metadata.json](routing_metadata.json).
2. `indice.json` actúa como el manifiesto canónico de la base de conocimiento, listando los archivos Markdown (`.md`) habilitados, su categoría y descripción.
3. `routing_metadata.json` agrupa los documentos por sectores temáticos (`grado`, `posgrado`, `cursos`, `institucional`, etc.) y define el núcleo común que viaja siempre.
4. Para cada consulta, el agente selecciona los sectores pertinentes (o hace *fallback* a la base completa en Vertex AI si la clasificación es ambigua; en LUX aplica un presupuesto estricto de bytes protegiendo las planillas críticas) e inyecta los archivos Markdown en el contexto del modelo.

### Estructura de Directorios

```
├── README.md               # Bienvenida, guía para áreas de la FCE y referencia técnica.
├── indice.json             # Manifiesto dinámico de todos los archivos consumidos por Luca.
├── routing_metadata.json   # Metadatos de sectores temáticos y derivación por área.
├── template.md             # Plantilla canónica para documentos académicos.
├── freshness.md            # Registro automático de frescura por archivo.
├── docs/                   # Documentación para personal de la FCE y contratos técnicos.
│   ├── GUIA_EDITORES.md    # Guía paso a paso para editores no técnicos (con glosario).
│   ├── GUIA_CARGA_DRIVE.md # Reglas para subir/actualizar planillas y documentos en Drive.
│   └── automation/         # Contratos y diseño de los pipelines de sincronización.
├── academica/              # Carreras de grado, planes de estudio 2027, correlatividades y cátedras.
├── agenda/                 # Agenda institucional de eventos y actividades de la FCE.
├── ciencia/                # Investigación, proyectos CAI+D, institutos y publicaciones.
├── compartidos/            # Posgrados interinstitucionales / compartidos con otras unidades.
├── complementos/           # Transcripciones automáticas de documentos y planillas de Google Drive.
├── cursos/                 # Cursos de formación profesional y capacitación (1 .md por curso).
├── cursos-posgrado/        # Cursos de posgrado y seminarios (sincronizados con CRM).
├── diplomaturas/           # Diplomaturas universitarias de la FCE.
├── docentes/               # Plantel docente, horarios de consulta y asignaciones por comisión.
├── estudiantes/            # Trámites de bedelía, calendario académico, becas y bienestar.
├── extension/              # Programas, proyectos y actividades de extensión universitaria.
├── institucional/          # Autoridades, historia, sedes, biblioteca y contactos generales.
├── internacionales/        # Movilidad estudiantil, convenios e intercambios.
├── operativos/             # Aulas virtuales (e-fich), SIU Guaraní y guías operativas.
├── posgrado-general/       # Normativa, admisión e información transversal de posgrado.
├── posgrados/              # Carreras de posgrado (maestrías, especializaciones y doctorados).
└── tools/                  # Scripts, scrapers, sincronizador CRM y validadores de CI.
    └── scraper/            # Pipelines de ingesta, tests unitarios y contratos JSON/MD.
```

### Reglas Críticas del Repositorio

- **Un archivo por curso**: Tanto en `cursos/` (formación) como en `cursos-posgrado/`, debe mantenerse estrictamente **un archivo Markdown por curso**. No se deben crear resúmenes agrupados con aranceles o fechas duplicadas.
- **Bloques sincronizados por CRM (`<!-- posgrado-crm:begin -->`)**: En las fichas de `posgrados/`, `diplomaturas/`, `compartidos/` y `cursos-posgrado/`, el estado de inscripción y la FAQ oficial se inyectan automáticamente desde el CRM entre marcadores `posgrado-crm`. No editar manualmente el interior de esos bloques ni agregar secciones estáticas de aranceles en los cursos de posgrado.
- **Declaración de Fuentes**: Todo documento curado debe declarar sus fuentes oficiales (URLs de `fce.unl.edu.ar` o documento de Drive) y la fecha de última revisión.
- **Formato de nombres**: Todos los archivos `.md` de contenido deben ir en minúsculas y separados por guiones medios (`kebab-case`, sin tildes ni espacios).

### Automatización y Pipelines (GitHub Actions)

| Workflow | Frecuencia / Disparo | Comportamiento y Regla de Publicación |
|---|---|---|
| `sync-posgrado-crm-kb.yml` | Cada 6 h + manual | Sincroniza estados de inscripción y FAQs desde el CRM (`/posgrado/tapir/propuestas/` y `/cursos/`). Publica directo en `main` si pasa las validaciones de contrato (`posgrado_crm_routes.json`); falla cerrado ante propuestas desconocidas o errores de red/WAF. |
| `ingest-drive.yml` | Diario (06:00 ART) + manual | Ingiere documentos y planillas de la carpeta institucional de Google Drive hacia `complementos/`. **Siempre abre un PR con etiqueta `needs-review`** (nunca auto-mergea). |
| `propose-posgrado-courses-kb.yml` | Semanal / manual | Detecta cursos nuevos de posgrado en la web oficial, genera su ficha `.md`, los registra en `posgrado_crm_routes.json` y propone el alta por PR (o auto-mergea si no tiene señales de revisión). |
| `propose-courses-kb.yml`, `propose-students-kb.yml`, `propose-sections-kb.yml` | Programado / manual | Detectan cambios en páginas oficiales de cursos, estudiantes y secciones institucionales. Publican cambios mecánicos limpios o abren PR `needs-review` si detectan anomalías o pérdidas de datos. |
| `validate-kb.yml` | En cada push y PR | Valida integridad de `indice.json`, `routing_metadata.json`, enlaces, formato y suite de tests (`npm test`). |
