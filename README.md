# sophia-knowledge

Base de conocimiento de **Sophia**, asistente virtual de la Facultad de Ciencias Económicas de la Universidad Nacional del Litoral (FCE-UNL).

Este repositorio es la **única fuente de verdad** que consume Sophia en runtime. Cada archivo Markdown describe una propuesta académica de la FCE (posgrado, diplomatura o curso de formación) con información curada, verificada y mantenida por personas.

## Por qué este repo existe

Sophia anteriormente consumía información de múltiples fuentes (web scraping, Drive, Firestore vectorizado, endpoint CRM). Eso producía respuestas incoherentes entre runs, datos desactualizados y dificultad para mantener la información al día.

Este repo resuelve eso con un patrón simple inspirado en la versión Sophia AIStudio que sí funciona:

1. **Una sola fuente**: este repo.
2. **Contenido curado por humanos**: cada MD pasa por revisión humana antes de ser publicado.
3. **Versionado en git**: cualquier cambio queda auditado (PR + diff).
4. **Carga dinámica**: el agente lee el `indice.json` y bajan los MDs por raw.githubusercontent.com.

## Estructura

```
/posgrados/         → 11 carreras de posgrado (doctorado, maestrías, especializaciones)
/diplomaturas/      → diplomaturas universitarias superiores (posgrado)
/cursos/            → cursos de formación
/template.md        → plantilla canónica que todo MD debe seguir
/indice.json        → lista qué MDs cargar (path + descripción + categoría)
```

## Cómo se actualiza un MD

1. **Cambio menor** (corregir typo, actualizar fecha, ajustar texto): editás el MD directamente, hacés PR, alguien aprueba.
2. **Cambio mayor** (nueva edición de un programa, cambio de plan de estudios): editás el MD respetando el template, agregás la fuente verificada (URL FCE oficial o documento Drive), hacés PR.
3. **Programa nuevo** (carrera/curso que no estaba): creás el MD desde `/template.md`, lo agregás en `/indice.json`, hacés PR.

El cambio se ve en Sophia **al próximo deploy** (o al refresco del cache, según configuración del agente).

## Verificación de fuentes

Cada MD debe declarar al final:
- Las URLs oficiales consultadas (web FCE y/o Drive)
- Fecha de última revisión humana
- Persona que revisó

Eso es lo que separa este KB de un scraping automático: **calidad sobre cantidad**.

## Quién consume este repo

El agente Sophia en producción lo lee al startup y al refresco de cache. Mirá `agente-sophia-v2/src/knowledge_base.js` (en el repo del agente) para ver el código exacto.
