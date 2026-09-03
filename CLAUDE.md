# sophia-knowledge

Base de conocimiento de Sophia, asistente virtual de la FCE-UNL. El contenido en Markdown lo
sincronizan pipelines automáticos desde la web oficial y desde Drive. `tools/scraper/` es el
pipeline; el resto del repo es contenido generado.

## Principio

**Automático por defecto.** Si el cambio viene de la web oficial o de lo que administra la
facultad, se publica solo. La revisión humana es para errores del proceso, no para cambios
normales. Altas, bajas y modificaciones son normales.

Queda para revisión humana **solo** esto:

- Un dato duro (monto, email, teléfono, URL) que no aparece ni en el scrape ni en la ficha anterior.
- Contradicción interna en la ficha.
- Un scrape vacío o degradado.
- Eliminación completa de una sección sensible.

Todo lo demás auto-mergea. Si una regla nueva manda a revisión algo que la facultad cambió de forma
legítima, esa regla está mal.

## Reglas de trabajo

1. **Diagnosticá antes de arreglar.** Identificá y reportá la causa antes de tocar código. No
   parchees el síntoma.
2. **Un test que no falla contra el estado previo no prueba nada.** Verificá que falla antes del fix.
3. **No ablandes los candados.** `classify_diff.mjs` (procedencia, secciones sensibles) y
   `generate_md.mjs` (`insufficient-raw`, `raw-regression`) existen porque el pipeline publicó una
   ficha inventada. Si el trabajo parece requerir aflojarlos, pará y avisá.
4. **PR, no merge directo a `main`.**
5. **`npm test` en `tools/scraper/` en verde** antes de terminar. Node 22+. Los tests no usan red ni
   `GEMINI_API_KEY`.
6. **Si la realidad del código no coincide con lo que te pedí, pará y avisá.** No improvises.
7. **Un fallo silencioso es peor que un fallo ruidoso.** Si encontrás algo que se rompe sin avisar,
   marcalo aunque no sea parte de la tarea.

## Alcance

- Fichas `.md`, `indice.json` y `routing_metadata.json` los generan los pipelines. No los edites a
  mano salvo pedido explícito.
- `taxonomy.json` y `sources.json` se tocan solo cuando la tarea lo pide.
- No des de alta fuentes nuevas por iniciativa propia.

## Trampas conocidas

- **Ramas.** `sync-kb.yml` genera `kb-sync/update-${slug}` por cada source. Los workflows dedicados
  hardcodean la suya. Si colisionan, uno pisa al otro con `push -f` y el contenido se pierde con
  todos los runs en verde. Lo cubre `tests/workflow_branches.test.mjs`; cualquier rama nueva tiene
  que pasarlo.
- **State files.** La fecha en `tools/scraper/state/` es la última vez que el contenido **aterrizó
  en `main`**, no la última corrida. Para saber si un pipeline corrió, mirá Actions.
- **Bajas de cursos.** La regla es "no figura en el listado oficial", no "ya pasó la fecha de
  inicio". La facultad da de baja unos días después del inicio. Un curso que arrancó hoy y sigue
  publicado no es una baja.
- **Datos preservados.** El generador conserva datos verificados de la ficha anterior que no están
  en el scrape (regla R6). Cualquier verificación tiene que aceptar el scrape **o** la ficha
  anterior como respaldo, o marca como sospechoso todo lo preservado.

## Comandos

```
cd tools/scraper && npm test          # tests
gh run list --workflow=<archivo>.yml  # historial de un pipeline
gh pr list                            # PRs abiertos
```
