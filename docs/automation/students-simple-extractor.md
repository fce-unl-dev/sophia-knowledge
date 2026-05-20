# Extractor simple de páginas de Estudiantes

Estado: C.2

Script: `tools/scraper/scrape_students.mjs`

## Objetivo

Generar candidatos Markdown para páginas simples de `https://www.fce.unl.edu.ar/estudiantes/` sin publicar contenido automáticamente.

Este extractor es deliberadamente conservador: procesa solo páginas marcadas como simples y deja diferidas las fuentes que requieren snapshots, revisión de privacidad o resolución de contenido dinámico.

## Qué procesa en C.2

Fuentes simples:

- `estudiantes-home`
- `estudiantes-examenes`
- `estudiantes-tramites`
- `estudiantes-consultas`
- `estudiantes-pai`
- `estudiantes-centro-estudiantes`

## Qué deja diferido

- `estudiantes-examenes-finales`: puede tener Google Sheets con turnos de examen.
- `estudiantes-examenes-parciales`: puede depender de iframe.
- `estudiantes-inscripciones-cursado`: puede contener listados nominales.
- `estudiantes-parciales-notas-muestras`: página dinámica o sistema externo.

Estas fuentes deben tratarse con snapshot Markdown revisable y filtro de privacidad antes de publicarse.

## Comandos

```bash
cd tools/scraper

# Catálogo/meta sin candidatos
node scrape_students.mjs

# Catálogo/meta + candidatos en state/estudiantes/candidates/
node scrape_students.mjs --write-candidates

# Procesar una sola fuente
node scrape_students.mjs --slug=estudiantes-examenes --write-candidates

# Solo report JSON por stdout
node scrape_students.mjs --no-write
```

## Outputs

```text
tools/scraper/state/estudiantes/
  estudiantes.meta.json
  estudiantes.catalog.json
  candidates/
    estudiantes-examenes.candidate.md
    ...
```

`estudiantes.catalog.json` y `candidates/` son regenerables y quedan ignorados por `.gitignore`.

## Señales de revisión

El extractor marca `requires_review` si detecta:

- iframe;
- Google Sheets;
- posibles datos personales/listados nominales;
- sistemas externos como SIU/SICA/CUP/Bedelía Móvil;
- contenido textual demasiado corto.

## Política

- No modifica `/estudiantes/` publicado.
- No modifica `indice.json`.
- No scrapea sistemas autenticados.
- No publica listados nominales automáticamente.
- Todo candidato debe entrar luego por PR humano.
