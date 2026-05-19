# sophia-knowledge

Base de conocimiento de **Sophia**, asistente virtual de la Facultad de Ciencias Económicas de la Universidad Nacional del Litoral (FCE-UNL).

Este repositorio es la **única fuente de verdad** que consume Sophia en runtime. Cada archivo Markdown describe información curada, verificada y mantenida por personas.

## Por qué este repo existe

Sophia anteriormente consumía información de múltiples fuentes (web scraping, Drive, Firestore vectorizado, endpoint CRM). Eso producía respuestas incoherentes entre runs, datos desactualizados y dificultad para mantener la información al día.

Este repo resuelve eso con un patrón simple inspirado en la versión Sophia AIStudio que sí funciona:

1. **Una sola fuente vigente**: este repo.
2. **Contenido curado por humanos**: cada MD pasa por revisión humana antes de ser publicado.
3. **Versionado en git**: cualquier cambio queda auditado (PR + diff).
4. **Carga dinámica**: el agente lee el `indice.json` y baja los MDs por raw.githubusercontent.com.

> Nota terminológica: este repo no debe confundirse con intentos anteriores de recuperación vectorial. La fuente vigente es la base de conocimiento cargada desde `indice.json`.

## Estructura vigente

```
/posgrados/         → 12 carreras de posgrado (doctorado, maestrías, especializaciones)
/diplomaturas/      → diplomaturas universitarias superiores
/compartidos/       → posgrados compartidos con otras unidades académicas
/operativos/        → información operativa general para consultas frecuentes
/cursos/            → cursos de formación profesional, con 1 MD por curso
/posgrado-general/  → páginas generales de posgrado transformadas a MD
/template.md        → plantilla canónica que todo MD académico debe seguir
/indice.json        → lista qué MDs carga Sophia (path + descripción + categoría)
/tools/scraper/     → herramientas candidatas para automatización; no son fuente publicada salvo PR aprobado
```

## Regla para cursos de formación

Los cursos de formación profesional se mantienen como **un Markdown por curso**.

No se debe indexar un documento agregado tipo `cursos/cursos-de-formacion-activos.md`, porque duplica información ya cargada en los MD individuales y puede generar contradicciones.

La página externa de cursos puede usarse como **fuente primaria de detección** para proponer altas, bajas o cambios, pero el resultado debe pasar por PR humano antes de incorporarse al índice.

## Cómo se actualiza un MD

1. **Cambio menor** (corregir typo, actualizar fecha, ajustar texto): editás el MD, hacés PR, alguien aprueba.
2. **Cambio mayor** (nueva edición de un programa, cambio de plan de estudios): editás el MD respetando el template, agregás la fuente verificada (URL FCE oficial o documento Drive), hacés PR.
3. **Programa nuevo** (carrera/curso/página relevante que no estaba): creás el MD, lo agregás en `/indice.json`, hacés PR.

El cambio se ve en Sophia **al próximo deploy** o al refresco del cache, según configuración del agente.

## Verificación de fuentes

Cada MD debe declarar al final:

- Las URLs oficiales consultadas (web FCE y/o Drive)
- Fecha de última revisión humana
- Persona que revisó

Eso es lo que separa este KB de un scraping automático: **calidad sobre cantidad**.

## Automatización segura

Principio rector: automatizar detección y propuesta, **no merge automático ni actualización directa a producción**.

Las herramientas de `/tools/scraper/` pueden usarse para detectar diferencias y generar candidatos, pero los cambios reales al KB deben entrar por PR con diff legible para revisión humana.

El contrato operativo vigente está documentado en [`docs/automation/pipeline-contract.md`](docs/automation/pipeline-contract.md).

## Quién consume este repo

El agente Sophia en producción lo lee al startup y al refresco de cache. Mirá `agente-sophia-v2/src/knowledge_base.js` (en el repo del agente) para ver el código exacto.
