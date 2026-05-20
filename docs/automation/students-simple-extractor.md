# Extractor de Estudiantes por temas del menú

Estado: C.2 corregido

Script: `tools/scraper/scrape_students.mjs`

## Objetivo

Generar candidatos Markdown respetando la estructura real de `https://www.fce.unl.edu.ar/estudiantes/`: **un MD por título/tema del menú**, incorporando la página principal y las subpáginas relacionadas con ese mismo tema.

No publica contenido automáticamente y no modifica `indice.json`.

## Temas incluidos

| Tema en la web | MD candidato | Observación |
|---|---|---|
| Ingreso 2026 | `estudiantes/ingreso-2026.md` | Vigente. |
| Trámites internos | `estudiantes/tramites-internos.md` | Agrupa principal + ingresantes + estudiantes + graduados. |
| Calendario Académico | `estudiantes/calendario-academico.md` | Tema propio. |
| Bienestar Estudiantil | `estudiantes/bienestar-estudiantil.md` | Agrupa BAPI, becas UNL, movilidad y PAI. |
| Pasantías rentadas | `estudiantes/pasantias-rentadas.md` | Tema propio. |
| Prácticas Profesionales Supervisadas | `estudiantes/practicas-profesionales-supervisadas.md` | Tema propio. |
| Info sobre inscripciones a cursado | `estudiantes/inscripciones-cursado.md` | Revisar privacidad si aparecen listados. |
| SIU Guaraní | `estudiantes/siu-guarani.md` | Solo explicar finalidad/acceso; no datos autenticados. |
| Sistema Informático de Consultas de Alumnos (SICA) | `estudiantes/sica.md` | Solo explicar finalidad/acceso; no datos autenticados. |
| Exámenes | `estudiantes/examenes.md` | Agrupa exámenes, finales y parciales; planillas/iframes quedan marcados para snapshot. |
| Clases de Consultas | `estudiantes/clases-consultas.md` | Agrupa consultas y subpáginas relacionadas de notas/muestras/avisos. |
| Centro de Estudiantes | `estudiantes/centro-estudiantes.md` | Tema propio. |
| Horarios de Atención | `estudiantes/horarios-atencion.md` | Tema propio. |
| Beneficios para Posgrados FCE UNL | `estudiantes/beneficios-posgrados-fce-unl.md` | Tema propio, aunque esté dentro de Estudiantes. |

## Temas excluidos

| Tema | Motivo |
|---|---|
| Ingreso 2025 | Obsoleto; fue reemplazado por Ingreso 2026. |

## Regla de agrupación

Cada candidato MD incluye:

1. el título/tema del menú;
2. la página principal del tema;
3. las subpáginas relacionadas con ese mismo título/tema;
4. enlaces relevantes detectados;
5. advertencias para Sophia;
6. fuentes consultadas.

Esto replica el criterio usado en el resto del KB: no se crea un MD por cada URL técnica si varias URLs forman un mismo bloque temático para el usuario.

## Señales de revisión

El extractor marca `requires_review` si detecta:

- iframe;
- Google Sheets;
- posibles datos personales/listados nominales;
- sistemas externos como SIU/SICA/CUP/Bedelía Móvil;
- subpáginas que no pudieron descargarse.

La señal no bloquea la generación del candidato: sirve para que el PR humano se revise con cuidado.

## Comandos

```bash
cd tools/scraper

# Catálogo/meta sin candidatos
node scrape_students.mjs

# Catálogo/meta + candidatos en state/estudiantes/candidates/
node scrape_students.mjs --write-candidates

# Procesar un solo tema
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
    estudiantes-tramites-internos.candidate.md
    ...
```

`estudiantes.catalog.json` y `candidates/` son regenerables y quedan ignorados por `.gitignore`.

## Política

- No modifica `/estudiantes/` publicado.
- No modifica `indice.json`.
- No scrapea sistemas autenticados.
- No publica listados nominales automáticamente.
- Sheets e iframes se detectan, pero para responder sobre su contenido hace falta snapshot Markdown revisado.
- Todo candidato debe entrar luego por PR humano.
