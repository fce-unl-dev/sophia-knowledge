# Pipeline de sync del KB

Pipeline de automatización del KB de Sophia. Disparable manualmente desde:

1. **UI de GitHub Actions** → workflow "Sync KB" → "Run workflow".
2. **Dashboard admin del agente Sophia** (Fase 2, pendiente) → llama al workflow vía GitHub API.
3. **Local** (para debug o smoke test) → ver sección "Correr local".

## Componentes

| Script | Responsabilidad | Estado |
|---|---|---|
| `scrape.mjs` | Descubre menú lateral en microsites FCE + baja subpáginas. Diff-first con hash sha256. | ✅ 30 tests |
| `generate_md.mjs` | Llama Gemini 2.5 Flash con template + MD actual + scrape → produce MD candidato. | ✅ 20 tests |
| `validate.mjs` | Estructura (10 secciones obligatorias), patrones prohibidos, placeholders, tamaño, URLs (HEAD). | ✅ 25 tests |
| `classify_diff.mjs` | Decide auto-merge vs review humano comparando secciones contra la lista `sensitive_sections`. | ✅ 15 tests |
| `run_pipeline.mjs` | Orquestador: corre los 4 anteriores para un slug y produce un report JSON con `decision`. | (glue, sin tests propios) |
| `.github/workflows/sync-kb.yml` | Workflow_dispatch con matrix paralela. Ejecuta git ops según el report. | — |

## Decisiones del pipeline

`run_pipeline.mjs` produce un report con `decision` ∈:

| Decisión | Qué hace el workflow | Cuándo se da |
|---|---|---|
| `no_change` | Solo actualiza `state/{slug}.meta.json` (registra `last_checked_at`). | El hash del scrape no cambió desde la corrida anterior. |
| `auto_merge` | Commit directo a `main` con el MD nuevo. **Silencioso, sin review.** | Solo cambiaron secciones NO sensibles (intro narrativa, plan de estudios sin cambios estructurales, etc.). |
| `requires_review` | Abre PR con label `needs-review` y comentario detallado de qué cambió. | Cambió al menos una sección sensible: Modalidad, Aranceles, Próxima cohorte, Contacto, CONEAU, Requisitos. |
| `rejected` | NO commitea. Loguea warning. | Validación falló (estructura rota, patrón prohibido, placeholder sin reemplazar). |
| `error` | NO commitea. Loguea warning. | Fallo técnico (Gemini cayó, scrape 404, etc.). El próximo run vuelve a intentar. |
| `skipped` | NO procesa. | El source tiene `strategy: "TBD"`. |

## Modos

- `refresh` (default): respeta diff-first. Si el scrape no cambió, decisión = `no_change` y skipea LLM (ahorra cuota).
- `force`: ignora el hash previo. Re-genera el MD aunque no haya cambios en el HTML. Útil después de cambiar el prompt del LLM o el template.
- `dry-run`: corre todo (scrape + generate + validate + classify) y reporta la decisión pero NO commitea ni abre PRs. Útil para auditar qué pasaría.

## Configuración inicial (una sola vez)

1. **Crear API key de Gemini**:
   - Ir a https://aistudio.google.com/apikey y generar una key.
   - En el repo `fce-unl-dev/sophia-knowledge` → Settings → Secrets and variables → Actions → New repository secret.
   - Name: `GEMINI_API_KEY`. Value: la key.

2. **Verificar permisos del `GITHUB_TOKEN`**:
   - Settings → Actions → General → Workflow permissions → "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests".

3. (Opcional) **Configurar protección de main**:
   - Settings → Branches → Branch protection rule para `main` → "Require a pull request before merging" desmarcado (porque permitimos auto-merge para cambios no sensibles) pero "Require status checks" puede usarse para correr el test suite antes de mergear.

## Correr local (debug)

```bash
cd tools/scraper

# Cargar API key
export GEMINI_API_KEY="..."

# Smoke test 1: solo scrape (sin LLM)
node scrape.mjs --slug=mba

# Smoke test 2: scrape + generate (consume cuota Gemini)
node generate_md.mjs --slug=mba

# Smoke test 3: validar el candidato
node validate.mjs --file=state/mba.candidate.md --current=../posgrados/mba.md

# Smoke test 4: clasificar diff
node classify_diff.mjs --candidate=state/mba.candidate.md --current=../posgrados/mba.md

# E2E: pipeline completo para un slug
node run_pipeline.mjs --slug=mba --mode=dry-run

# Tests unitarios
npm test
```

## Estructura `state/`

```
state/
  .gitignore           # ignora *.raw.txt (regenerable, grande)
  {slug}.meta.json     # commiteado: hash, urls, last_checked_at → diff-first
  {slug}.raw.txt       # NO commiteado: output del scrape, ~100-500KB
  {slug}.candidate.md  # NO commiteado: MD generado por Gemini (ephemeral)
  {slug}.gen.meta.json # NO commiteado: tokens usados, modelo, timestamps
```

## Agregar una fuente nueva

1. Verificar la URL real con `curl -sL "<url>" | grep blog-content` (o `act=showSubcategoria` para microsites).
2. Editar `sources.json`:
   ```json
   {
     "slug": "nuevo-programa",
     "indice_path": "posgrados/nuevo-programa.md",
     "url": "https://fce.unl.edu.ar/nuevo-programa/",
     "strategy": "fce-microsite"
   }
   ```
3. Disparar el workflow con `source=nuevo-programa` y `mode=force`. Como no hay MD previo, classify devuelve `requires_review` por `no_existing_md` → se abre PR con el MD nuevo.
4. **Al mergear ese PR, también agregar entry en `/indice.json`** (raíz del repo KB) para que el agente Sophia lo cargue en runtime. Si no se agrega al indice, el MD existe en el repo pero el agente no lo ve. Ejemplo:
   ```json
   {
     "path": "posgrados/nuevo-programa.md",
     "title": "Nuevo Programa de Posgrado",
     "category": "Maestría",
     "programCode": "NP",
     "canonicalUrl": "https://fce.unl.edu.ar/nuevo-programa/"
   }
   ```

## Organización de carpetas en el KB

- `posgrados/` — fichas de programas individuales (12 carreras de posgrado FCE)
- `diplomaturas/` — fichas de diplomaturas individuales
- `compartidos/` — fichas de programas compartidos con otras facultades UNL
- `cursos/` — fichas de cursos de formación profesional
- `operativos/` — páginas operativas del grado (régimen, aulas, ingreso)
- `posgrado-general/` — páginas overview e info general de la sección Posgrado (estudiantes, becas, beneficios, índices de doctorados/maestrías/especializaciones, inscripciones, crédito fiscal). El sidebar real del posgrado en fce.unl.edu.ar/posgrado/ tiene estos items como categorías o posts; agregarlos al KB cubre preguntas comunes que las fichas individuales no responden (ej. trámite de diploma digital, beneficios para graduados, becas).

## Estrategias soportadas

- `fce-microsite`: descubre menú lateral del template FCE (regex sobre `index.php?act=showSubcategoria|showCategoria|showNoticia`). Funciona para los 12 posgrados + 3 diplomaturas FCE.
- `fce-wordpress`: páginas internas del sitio FCE construidas sobre WordPress (theme Académica). Extrae solo el contenido de `<div class="blog-content">` descartando sidebar y footer. Aplica a operativos (regimen, aulas, ingreso) y a páginas de programa con URL larga (empresas-familiares).
- `wordpress-homepage`: baja solo la home y extrae main content. Para sitios de otras facultades (FHUC, FCA, FCJS) que NO usan el template FCE.
- `TBD`: marcador para estrategias todavía no implementadas. El workflow lo saltea con `decision: skipped`.

## Limitaciones conocidas

- **Cursos de formación profesional** (~22 cursos) NO están en `sources.json`. El endpoint del listado oficial (`cursos_de_formacion/index.php?act=showCursos`) requiere sesión — devuelve página de login si se accede sin cookie del iframe padre. Los MDs en `/cursos/` se siguen manteniendo manualmente hasta que la facultad provea un endpoint scrapeable (Fase 1.3 o pedido al equipo de Sistemas FCE).

- **Mismatch template para páginas operativas**: el template canónico está pensado para programas académicos (con Plan de estudios, Cuerpo docente, etc.). Las páginas operativas (regimen, aulas, ingreso) son procesos, no programas — el LLM marca correctamente "no aplica" en secciones que no corresponden, pero el output tiene mucho "null". Aceptable porque siempre pasa por review humano (decisión `requires_review` por `structural_change` cuando el MD actual usa secciones diferentes a las del template). A futuro se puede agregar un campo `template_override` por source para usar un template más liviano en operativos.

- **Drive** no se sincroniza en esta fase. Fase 2.

- **Race condition** en push a `main` cuando varios jobs de la matrix terminan en `auto_merge` simultáneamente. Mitigado con retry + pull-rebase (5 intentos con backoff random); en la práctica es raro porque `max-parallel: 3` y la mayoría de fuentes da `no_change`.
