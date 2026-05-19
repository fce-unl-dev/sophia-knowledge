# B.2 Contrato del pipeline auto-update

Fecha: 2026-05-19

## Objetivo

Definir cómo puede operar la automatización de actualización del KB de Sophia sin romper el principio rector del proyecto:

> Automatizar detección y propuesta vía PR, no merge automático ni actualización directa a producción.

## Fuente vigente

- La fuente publicada que consume Sophia es `indice.json` + los Markdown listados allí.
- Las fuentes externas (web FCE, Google Sheets, Drive u otras) son **fuentes primarias para detectar cambios**, no reemplazan al KB publicado.
- Las herramientas en `/tools/scraper/` son automatización de apoyo y no deben considerarse fuente vigente por sí mismas.

## Estados permitidos del pipeline

El pipeline puede clasificar una corrida así:

| Estado | Significado | Acción permitida |
|---|---|---|
| `no_change` | La fuente primaria no cambió respecto del último estado conocido | No abrir PR. No tocar `main`. |
| `candidate_ready` | Hay cambios detectados y se generó un candidato válido | Abrir PR con diff humano. |
| `requires_review` | Cambiaron datos sensibles o hay dudas | Abrir PR marcado como revisión requerida. |
| `rejected` | El candidato falló validaciones | No abrir PR. Reportar error. |
| `error` | Fallo técnico | No abrir PR. Reportar error. |
| `skipped` | Fuente aún no implementada o aislada | No hacer nada. |

Nota: el código actual usa internamente `auto_merge` para cambios de bajo riesgo. Bajo este contrato, `auto_merge` debe interpretarse como `candidate_ready`: **abre PR, no mergea**.

## Qué puede hacer automáticamente

La automatización puede:

1. Leer fuentes primarias configuradas.
2. Detectar cambios.
3. Generar snapshots/candidatos Markdown.
4. Ejecutar validaciones estructurales.
5. Clasificar riesgo.
6. Abrir PRs con:
   - archivo(s) modificados;
   - fuente consultada;
   - secciones cambiadas;
   - motivo de la clasificación;
   - checklist de revisión.

## Qué no puede hacer automáticamente

La automatización no puede:

1. Hacer merge automático.
2. Pushear cambios de contenido directo a `main`.
3. Agregar entradas a `indice.json` sin PR.
4. Crear documentos agregados que dupliquen MDs canónicos.
5. Reemplazar revisión humana en datos sensibles.
6. Actualizar producción directamente.

## Datos sensibles

Se consideran sensibles, como mínimo:

- fechas de inscripción;
- fechas de cursado o examen;
- aranceles;
- modalidad;
- requisitos de admisión;
- contactos institucionales;
- acreditación CONEAU;
- links de inscripción o formularios;
- cualquier dato que afecte una decisión concreta del usuario.

Si cambia cualquiera de estos campos, el PR debe quedar marcado como revisión requerida.

## Política de revisión operativa

Para reducir carga operativa:

1. Codex puede hacer una **pre-revisión técnica** de los PRs generados por automatización.
2. Si el cambio es mecánico, bien formado, con fuente oficial clara y sin dudas, Codex puede recomendar merge.
3. El usuario humano solo debe ser escalado cuando exista:
   - duda sobre interpretación del dato;
   - cambio sensible;
   - conflicto entre fuentes;
   - alta/baja de contenido en `indice.json`;
   - cambio que afecte muchas páginas;
   - fallo de validación o señal de riesgo.
4. El merge final sigue siendo humano hasta que se defina una política institucional distinta.

## Contrato para cursos de formación

Los cursos de formación profesional deben mantenerse como **1 MD por curso**.

El pipeline de cursos debe:

1. Leer el listado oficial de cursos activos.
2. Detectar altas, bajas y cambios.
3. Mapear cada curso a un slug estable.
4. Generar o actualizar solo el MD del curso afectado.
5. Proponer cambios por PR.
6. No generar `cursos/cursos-de-formacion-activos.md`.

## Contrato para páginas de estudiantes

Las páginas de `https://www.fce.unl.edu.ar/estudiantes/` y subpáginas deben tratarse como contenido informativo general para alumnos.

Reglas:

1. Crear 1 MD por página/subpágina relevante.
2. Para planillas Google Sheets, crear snapshots Markdown estructurados.
3. Incluir fuente primaria, fecha de lectura y, si está disponible, última modificación detectada.
4. No dejar solo el link si Sophia debe responder sobre el contenido de la planilla.
5. Separar snapshots por año académico cuando corresponda.

## Uso del workflow `Sync KB`

Hasta que B.3/B.4 estén completos:

- usar preferentemente `mode: dry-run`;
- no usar `force` salvo prueba controlada;
- no usar `source: all` si no se revisaron las fuentes afectadas;
- revisar logs antes de mergear cualquier PR generado.

## Checklist mínimo para revisar un PR del KB

Antes de mergear:

- [ ] Los archivos modificados son los esperados.
- [ ] No se agregó duplicación de fuentes.
- [ ] `indice.json` no apunta a archivos inexistentes.
- [ ] Las URLs oficiales están declaradas.
- [ ] Fechas/aranceles/modalidad/contactos fueron revisados si cambiaron.
- [ ] El diff es legible y acotado.
- [ ] No hay merge automático ni push directo a producción.
