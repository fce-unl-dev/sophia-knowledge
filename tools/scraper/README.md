# Pipeline de sync del KB

Pipeline de automatización del KB de Sophia. Disparable manualmente desde:

1. **UI de GitHub Actions** → workflow "Sync KB" → "Run workflow".
2. **Dashboard admin del agente Sophia** (pendiente) → llama al workflow vía GitHub API.
3. **Local** (para debug o smoke test) → ver sección "Correr local".

## Componentes

| Script | Responsabilidad | Estado |
|---|---|---|
| `scrape.mjs` | Descubre menú lateral en microsites FCE + baja subpáginas. Diff-first con hash sha256. | vigente |
| `generate_md.mjs` | Llama Gemini 2.5 Flash con template + MD actual + scrape → produce MD candidato. | vigente para fuentes single-output |
| `validate.mjs` | Estructura, patrones prohibidos, placeholders, tamaño, URLs (HEAD). | vigente |
| `classify_diff.mjs` | Decide candidato de bajo riesgo vs revisión humana comparando secciones contra `sensitive_sections`. | vigente |
| `run_pipeline.mjs` | Orquestador para un slug single-output y produce un report JSON con `decision`. | vigente |
| `scrape_courses.mjs` | Scraper determinístico multi-output para cursos de formación: listado activo + detalle + candidatos 1 MD por curso. | B.3 |
| `scrape_students.mjs` | Scraper determinístico de `/estudiantes/`: 1 MD por tema del menú, agrupando página principal + subpáginas. Ver `docs/automation/students-simple-extractor.md`. | vigente |
| `scrape_sheets.mjs` | Helper: descarga una pestaña de Google Sheet pública como CSV y la parsea (RFC 4180). Usado por otros scrapers. | vigente |
| `scrape_drive.mjs` | Ingesta de complementos desde Google Drive (PDF, docx, Sheets); resuelve el sector de cada archivo vía taxonomía canónica + fallback Gemini. | vigente |
| `section_candidates.mjs` | Funciones puras: convierten el crawl de una rama WordPress completa en candidatos (1 MD por subpágina importante; páginas flacas y documentos quedan como enlaces en el MD landing). Sin red ni I/O. | vigente |
| `generate_routing_metadata.mjs` | Taxonomía canónica (`taxonomy.json`): única fuente de verdad de sectores/carpetas para web y Drive. Resuelve a qué sector y carpeta del KB va cada doc. | vigente |
| `propose_courses_update.mjs` | Orquestador (contrato B.5): corre `scrape_courses`, materializa candidatos en `/cursos/` + `indice.json` y arma el cuerpo del PR. No borra cursos dados de baja; los reporta. | vigente |
| `propose_students_update.mjs` | Orquestador (contrato C.3): corre `scrape_students`, materializa candidatos en `/estudiantes/` + `indice.json` y arma el PR. No borra docs existentes. | vigente |
| `propose_sections_update.mjs` | Orquestador multi-sección WordPress (`/academica/`, `/docentes/`, `/institucional/`, `/ciencia/`, `/extension/`, `/internacionales/`): crawlea, genera 1 MD por subpágina vía `section_candidates`, clasifica diff y arma el PR. No borra docs existentes. | vigente |
| `freshness_report.mjs` | Reporta antigüedad de los docs del KB comparando draft autogenerado vs última revisión humana. | vigente |
| `validate_index.mjs` | Valida `indice.json`: estructura, paths existentes, duplicados y reglas anti-agregado de cursos. | B.4 |
| `validate_links.mjs` | Valida formato de URLs del índice, sources y MDs; opcionalmente chequea red con `--network`. | B.4 |
| `validate_course_catalog.mjs` | Valida catálogos generados por `scrape_courses.mjs` o ejecuta scraper vivo con `--run-scraper`. | B.4 |
| `.github/workflows/sync-kb.yml` | Workflow manual genérico (single-output vía `run_pipeline.mjs`). Bajo contrato B.2 abre PRs; no pushea contenido directo a `main`. | vigente |
| `.github/workflows/propose-courses-kb.yml` | Workflow manual "Propose Courses KB": corre `propose_courses_update.mjs` y abre PR de cursos. Ver `docs/automation/course-proposals.md`. | vigente (B.5) |
| `.github/workflows/propose-students-kb.yml` | Workflow manual: corre `propose_students_update.mjs` y abre PR de `/estudiantes/`. | vigente |
| `.github/workflows/propose-sections-kb.yml` | Workflow manual: corre `propose_sections_update.mjs` y abre PR de las ramas WordPress del sitio. | vigente |
| `.github/workflows/mark-as-reviewed.yml` | Workflow de soporte: marca documentos como revisados por humano (actualiza metadatos de freshness). | vigente |
| `.github/workflows/validate-kb.yml` | Workflow automático de validación en PRs/push a main. | B.4 |

## Contrato B.2

El contrato operativo está documentado en `docs/automation/pipeline-contract.md`.

Resumen:

- no hay merge automático;
- no hay push directo de contenido a `main`;
- `auto_merge` se interpreta como candidato de bajo riesgo y abre PR;
- datos sensibles siempre requieren revisión;
- Codex puede pre-revisar PRs automatizados y escalar al usuario solo si hay dudas o riesgo.

## Validaciones automáticas (B.4)

El workflow `Validate KB` corre automáticamente en PRs y pushes a `main`.

Checks estables, sin red:

```bash
node --check tools/scraper/*.mjs
node tools/scraper/validate_index.mjs --kb-root=../.. --json
node tools/scraper/validate_links.mjs --kb-root=../.. --json
```

Checks opcionales con red, solo por `workflow_dispatch`:

```bash
node tools/scraper/validate_links.mjs --kb-root=../.. --network --json
node tools/scraper/validate_course_catalog.mjs --kb-root=../.. --run-scraper --json
```

La separación evita que PRs fallen por problemas temporales de red, pero permite validar fuentes vivas antes de conectar automatizaciones más fuertes.

## Decisiones del pipeline genérico

`run_pipeline.mjs` produce un report con `decision` ∈:

| Decisión | Qué hace el workflow actual | Cuándo se da |
|---|---|---|
| `no_change` | No abre PR y no toca `main`. | El hash del scrape no cambió desde la corrida anterior. |
| `auto_merge` | Abre PR de candidato de bajo riesgo. | Solo cambiaron secciones no sensibles. |
| `requires_review` | Abre PR de revisión requerida. | Cambió al menos una sección sensible o hubo cambio estructural. |
| `rejected` | NO commitea. Loguea warning. | Validación falló. |
| `error` | NO commitea. Loguea warning. | Fallo técnico, o el paso de generación abortó por scrape insuficiente o degradado. |
| `skipped` | NO procesa. | El source tiene `strategy: "TBD"`. |

### Guardas del scrape antes del modelo

`generate_md.mjs` corta antes de llamar a Gemini cuando el scrape no da para
generar una ficha honesta. En esos casos `run_pipeline.mjs` reporta
`decision: error` con el detalle en `report.error`:

| Status de `generateForSource` | Cuándo se da | Qué hacer |
|---|---|---|
| `insufficient-raw` | El scrape trajo menos caracteres útiles que `minRawChars` (default 600). | Abrir la URL a mano: casi siempre la página cambió de estructura y la `strategy` dejó de matchear. Si la fuente es legítimamente chica, bajar `minRawChars` en `sources.json` para ese source. |
| `raw-regression` | El scrape quedó por debajo del 40% del tamaño del de la corrida anterior (`raw_length` en `state/{slug}.gen.meta.json`). | Igual que arriba. No re-correr con `force` sin mirar la página primero. |

Ninguna de las dos gasta una llamada al modelo. Son dos de las cuatro guardas
compartidas: el catálogo completo, con umbrales y calibración, está en
"Guardas de los pipelines" más abajo.

Además, el clasificador aplica un candado determinista sobre la decisión del
auditor IA: si cambió una sección sensible, si el archivo es nuevo o si hubo
cambio estructural, la decisión pasa a `requires_review` aunque el modelo haya
dicho `auto_merge`. Lo que dijo el modelo queda registrado en `ai_decision` /
`ai_reason` del report, para poder medir después cuántas veces se equivocó.

## Guardas de los pipelines

Todas viven en `guards.mjs` y responden lo mismo: `null` si está todo bien, o un
objeto con `status` y un `reason` escrito para que lo lea un operador. Ninguna
ablanda: si disparan, se corta antes de gastar una llamada al modelo o de borrar
contenido del KB.

| Guarda | Qué mide | Default | Dónde corre |
|---|---|---|---|
| `checkRawFloor` | Caracteres útiles del scrape | 600 en fichas web, 200 en documentos sueltos | `generate_md`, `scrape_drive`, `scrape_students` |
| `checkRawRegression` | El scrape encogió contra la corrida anterior | corta por debajo del 40% | `generate_md` |
| `checkContentRegression` | El candidato encogió contra la ficha que pisaría | corta por debajo del 40% | `propose_courses_update`, `propose_sections_update` |
| `checkRemovalRatio` | Bajas netas sobre el inventario | corta arriba del 30%, mínimo 2 bajas netas | `scrape_drive` (scrape y apply), `propose_courses_update`, `propose_posgrado_courses_update` |

"Caracteres útiles" descarta líneas en blanco y colapsa espacios repetidos: un
`raw.txt` de 3 KB de sangrías no es un scrape útil.

### Por qué 30% y no "más bajas que activos"

La regla vieja de los dos `propose_*` — anomalía cuando las bajas superan a los
cursos activos — solo dispara cuando se cae más de la mitad del catálogo. El
24/08/2026 la carpeta `04-Posgrado` de Drive pasó de 18 a 5 archivos en una sola
corrida y el pipeline propuso borrar 12 fichas de trámites de posgrado: 42% del
inventario, con 0 errores y el run en verde. Una regla de mitad no lo toca.

El umbral está calibrado contra tres episodios reales, que son los casos de
`tests/guards.test.mjs`:

| Caso | Bajas / inventario | Altas | Veredicto |
|---|---|---|---|
| Drive, 24/08/2026 | 13 / 31 = 42% | 0 | corta |
| Cursos de formación | 3 / 16 = 19% | 0 | pasa |
| Cursos de posgrado | 2 / 8 = 25% | 4 | pasa (bajas netas negativas) |

Las altas compensan: un pipeline que trae contenido nuevo está mirando una
fuente sana. Y por debajo de 2 bajas netas el porcentaje es ruido — en un
inventario de 3, una sola baja ya es 33%.

La regla vieja no se sacó. Conviven, y alcanza con que dispare una.

### Qué pasa cuando una guarda corta

- `generate_md`: devuelve `insufficient-raw` o `raw-regression` y `run_pipeline`
  lo trata como error del paso, sin propagar el candidato.
- `propose_*`: la decisión pasa a `requires_review` con el motivo puesto, y **no
  se borra ni se sobrescribe nada**. El PR queda para revisión humana.
- `scrape_drive`: no marca ningún archivo como borrado, deja la anomalía en
  `state/complementos/drive.meta.json` bajo `removal_anomaly`, y el workflow
  termina en **rojo** en un paso final — después de abrir el PR con las altas
  legítimas de esa misma corrida, para no perderlas.

Ese último punto es deliberado. Un pipeline que se protege y sigue en verde
vuelve al problema de origen: nadie se entera de que la fuente está rota.

### Confirmar bajas masivas legítimas de Drive

La guarda del 30% no cambia: una baja grande puede ser legítima, pero también
puede indicar que Drive dejó de listar una carpeta. La confirmación humana se
pide solamente para resolver esa inconsistencia, no para cada baja normal.

La anomalía muestra el conteo, cada path y un digest SHA-256 que vincula la
decisión al inventario completo y al conjunto exacto de IDs desaparecidos. En
la primera detección ese estado todavía no está en `main`: el workflow lo
persiste en `kb-sync/update-drive`. Si se verificó manualmente que las bajas son
correctas, la rama de confirmación debe partir de esa rama exacta (no de
`main`) y revisarse mediante PR:

```bash
git fetch origin kb-sync/update-drive
git switch -c chore/confirm-drive-removal-<12-primeros-del-digest> \
  --track origin/kb-sync/update-drive
cd tools/scraper
node scrape_drive.mjs --confirm-removals \
  --actor="NOMBRE" \
  --reason="MOTIVO VERIFICADO"
git add state/complementos/drive.meta.json
git commit -m "chore(kb): confirm Drive removals"
git push -u origin chore/confirm-drive-removal-<12-primeros-del-digest>
gh pr create --base main --fill
```

Después de mergear ese PR, la próxima ingesta recalcula el digest. Solo si
coinciden versión, inventario y bajas, `--apply` elimina los complementos y sus
referencias del índice. La confirmación se consume y se reemplaza por
`last_confirmed_removal`, que es evidencia de auditoría inerte y nunca autoriza
otra corrida. Una confirmación ausente, vieja, incompleta o de otro conjunto
falla antes de escribir contenido. `force` solo reprocesa archivos y **nunca**
confirma bajas.

## Modos

- `refresh` (default): respeta diff-first. Si el scrape no cambió, decisión = `no_change` y skipea LLM.
- `force`: ignora el hash previo. Re-genera el MD aunque no haya cambios en el HTML.
- `dry-run`: corre todo y reporta la decisión pero NO commitea ni abre PRs.

## Scraper determinístico de cursos (B.3)

Los cursos de formación profesional son una fuente **multi-output**: un listado oficial contiene muchos cursos, y cada curso debe mapearse a un MD propio en `/cursos/`.

Por eso no se procesan con `run_pipeline.mjs` ni con `generate_md.mjs` en esta etapa.

### Qué hace `scrape_courses.mjs`

1. Lee el listado oficial `https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showCursos`.
2. Extrae por cada curso:
   - título;
   - fecha de inicio publicada;
   - URL de más información;
   - URL de consultas;
   - URL de pre-inscripción;
   - `id_curso` e ID de página de detalle cuando están disponibles.
3. Lee cada página de detalle.
4. Separa secciones conocidas: Fundamentación, Destinatarios, Requisitos, Contenidos, Objetivos, Datos clave, Modalidad, Evaluación, Certificación, Docentes y Costo.
5. Compara contra los cursos ya listados en `indice.json`.
6. Genera reportes y, opcionalmente, candidatos Markdown por curso.

### Comandos

```bash
cd tools/scraper

# Solo catálogo + meta
node scrape_courses.mjs

# Catálogo + candidatos Markdown en state/cursos-de-formacion/candidates/
node scrape_courses.mjs --write-candidates

# Solo report por stdout, sin escribir archivos
node scrape_courses.mjs --no-write
```

### Outputs

```text
state/cursos-de-formacion/
  cursos-de-formacion.meta.json
  cursos-de-formacion.catalog.json
  candidates/
    {slug}.candidate.md
```

Los candidatos son insumo para PR humano. No se publican automáticamente y no se agregan al índice sin revisión.

## Configuración inicial (una sola vez)

1. **Crear API key de Gemini** para las fuentes single-output que usan `generate_md.mjs`:
   - Ir a https://aistudio.google.com/apikey y generar una key.
   - En el repo `fce-unl-dev/sophia-knowledge` → Settings → Secrets and variables → Actions → New repository secret.
   - Name: `GEMINI_API_KEY`. Value: la key.

2. **Verificar permisos del `GITHUB_TOKEN`**:
   - Settings → Actions → General → Workflow permissions → "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests".

3. **Protección de `main` recomendada**:
   - Require a pull request before merging.
   - No permitir commits directos de contenido salvo mantenedores autorizados.

## Correr local (debug)

```bash
cd tools/scraper

# Cargar API key solo si se usa generate_md.mjs/run_pipeline.mjs
export GEMINI_API_KEY="..."

# Smoke test 1: solo scrape de fuente single-output
node scrape.mjs --slug=mba

# Smoke test 2: pipeline completo para un slug single-output
node run_pipeline.mjs --slug=mba --mode=dry-run

# Smoke test 3: cursos multi-output, sin LLM
node scrape_courses.mjs --no-write

# Validaciones B.4 sin red
node validate_index.mjs --kb-root=../.. --json
node validate_links.mjs --kb-root=../.. --json

# Validaciones B.4 con red
node validate_links.mjs --kb-root=../.. --network --json
node validate_course_catalog.mjs --kb-root=../.. --run-scraper --json
```

## Estructura `state/`

```text
state/
  .gitignore           # ignora raw/candidates regenerables
  {slug}.meta.json     # hash, urls, last_checked_at → diff-first
  {slug}.raw.txt       # NO commiteado: output del scrape
  {slug}.candidate.md  # NO commiteado: MD generado
  {slug}.gen.meta.json # NO commiteado: tokens/modelo/timestamps
```

## Agregar una fuente nueva single-output

1. Verificar la URL real.
2. Editar `sources.json`:
   ```json
   {
     "slug": "nuevo-programa",
     "indice_path": "posgrados/nuevo-programa.md",
     "url": "https://fce.unl.edu.ar/nuevo-programa/",
     "strategy": "fce-microsite"
   }
   ```
3. Disparar el workflow con `source=nuevo-programa` y `mode=force`.
4. El workflow abrirá PR. Al mergear, agregar también la entrada en `/indice.json` si corresponde.

## Organización de carpetas en el KB

- `posgrados/` — fichas de programas individuales.
- `diplomaturas/` — fichas de diplomaturas individuales.
- `compartidos/` — fichas de programas compartidos con otras facultades UNL.
- `cursos/` — fichas de cursos de formación profesional, 1 MD por curso.
- `operativos/` — páginas operativas del grado.
- `posgrado-general/` — páginas overview e información general de posgrado.

## Estrategias soportadas en el workflow genérico

- `fce-microsite`: descubre menú lateral del template FCE.
- `fce-wordpress`: páginas internas del sitio FCE construidas sobre WordPress.
- `wordpress-homepage`: baja solo la home y extrae main content.
- `TBD`: marcador para estrategias todavía no implementadas en el workflow genérico. El workflow lo saltea con `decision: skipped`.

## Limitaciones conocidas

- `scrape_courses.mjs` no corre por el workflow genérico `Sync KB`, sino por su propio workflow **Propose Courses KB** (`propose-courses-kb.yml`) vía `propose_courses_update.mjs`. Mismo criterio para estudiantes y secciones (workflows `propose-students-kb.yml` y `propose-sections-kb.yml`).
- Ningún proponente da de baja contenido automáticamente: los cursos/páginas que dejan de aparecer en la fuente se reportan en el cuerpo del PR para decisión humana.
- Las páginas operativas pueden requerir `template_override` porque el template académico no siempre aplica.
- La ingesta de Drive/Google Sheets (`scrape_drive.mjs`, `scrape_sheets.mjs`) se corre manualmente/local; todavía no tiene workflow propio en GitHub Actions.
