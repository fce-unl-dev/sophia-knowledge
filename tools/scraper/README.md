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
| `validate_index.mjs` | Valida `indice.json`: estructura, paths existentes, duplicados y reglas anti-agregado de cursos. | B.4 |
| `validate_links.mjs` | Valida formato de URLs del índice, sources y MDs; opcionalmente chequea red con `--network`. | B.4 |
| `validate_course_catalog.mjs` | Valida catálogos generados por `scrape_courses.mjs` o ejecuta scraper vivo con `--run-scraper`. | B.4 |
| `.github/workflows/sync-kb.yml` | Workflow manual. Bajo contrato B.2 abre PRs; no pushea contenido directo a `main`. | vigente |
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
| `error` | NO commitea. Loguea warning. | Fallo técnico. |
| `skipped` | NO procesa. | El source tiene `strategy: "TBD"`. |

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

- `scrape_courses.mjs` todavía no está conectado al workflow `Sync KB`; B.5 debe crear PR automático con diff humano para altas/bajas/cambios de cursos.
- Las páginas operativas pueden requerir `template_override` porque el template académico no siempre aplica.
- Drive/Google Sheets para estudiantes se incorporará como snapshots Markdown en fases posteriores.
