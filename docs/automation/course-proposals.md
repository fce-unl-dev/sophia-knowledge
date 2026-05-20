# Propuestas automáticas de cursos de formación

Este documento describe B.5: generación de PRs automáticos con diff legible para humanos para cursos de formación profesional.

## Principio operativo

- El scraper detecta cambios en la fuente oficial de cursos.
- El sistema genera una propuesta en una rama nueva.
- La propuesta entra por Pull Request.
- No hay merge automático.
- No hay push directo a `main`.
- Cada curso se mantiene como **1 MD por curso** en `/cursos/`.

## Workflow

Workflow: `.github/workflows/propose-courses-kb.yml`

Nombre en GitHub Actions: **Propose Courses KB**

Modos:

| Modo | Efecto |
|---|---|
| `refresh` | Usa diff-first. Si el hash del catálogo no cambió, no abre PR. |
| `force` | Genera propuesta aunque el hash no haya cambiado. Útil para regenerar formato. |
| `dry-run` | Ejecuta scraper y resumen, pero no pushea rama ni abre PR. |

## Qué cambia un PR generado

Un PR puede incluir:

- nuevos Markdown en `/cursos/`;
- actualizaciones de Markdown existentes en `/cursos/`;
- nuevas entradas en `indice.json` para cursos detectados por primera vez;
- `tools/scraper/state/cursos-de-formacion/cursos-de-formacion.meta.json` para conservar el hash estable del último catálogo propuesto/mergeado.

## Qué NO hace automáticamente

- No borra cursos que ya no figuran activos en la fuente.
- No elimina entradas de `indice.json`.
- No mergea PRs.
- No actualiza producción directamente.

Los cursos indexados que no aparecen activos se reportan en el cuerpo del PR como **bajas o cursos no activos en la fuente** para revisión humana.

## Script principal

Script: `tools/scraper/propose_courses_update.mjs`

Responsabilidades:

1. Ejecutar `scrape_courses.mjs`.
2. Generar candidatos Markdown por curso.
3. Comparar candidatos contra los MD actuales.
4. Agregar entradas nuevas a `indice.json` cuando haya cursos nuevos.
5. Escribir un resumen Markdown para el cuerpo del PR.
6. Rechazar defensivamente propuestas sin cursos activos o con paths inseguros.

## Checklist de revisión humana

1. Revisar el resumen del PR.
2. Mirar el diff de `/cursos/`.
3. Confirmar altas contra la fuente oficial.
4. Revisar bajas reportadas; decidir en un PR posterior si se archivan/eliminan.
5. Verificar que `indice.json` no duplique cursos.
6. Mergear solo si no hay dudas.
