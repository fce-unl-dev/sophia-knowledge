# C.1 — Inventario de fuentes de Estudiantes

Fecha: 2026-05-20
Repositorio: `fce-unl-dev/sophia-knowledge`

## Objetivo

Incorporar la sección `https://www.fce.unl.edu.ar/estudiantes/` y subpáginas relevantes a la base de conocimiento de Sophia sin duplicar contenido, sin merge automático y sin depender todavía de Drive como primer paso.

Este documento define el alcance inicial para que luego se pueda implementar scraper/convertidor con bajo riesgo.

## Principios

- La fuente vigente para Sophia sigue siendo `indice.json` + Markdown revisado.
- Cada tema relevante de estudiantes debe tener **un MD propio** en `/estudiantes/`.
- Las páginas índice pueden existir como MD propio solo si aportan contexto general; no deben duplicar en detalle lo que vive en páginas hijas.
- Google Sheets, iframes y PDFs no se indexan como links sueltos si Sophia debe responder sobre su contenido: deben convertirse a **snapshots Markdown estructurados**.
- Las bajas/cambios detectados se proponen por PR; no se mergea automáticamente.
- Si una fuente contiene datos personales, listados nominales o información sensible, debe quedar marcada como `requires_review` y no publicarse automáticamente.

## Fuentes web candidatas

| Prioridad | Slug propuesto | URL | MD destino propuesto | Tipo | Observación |
|---|---|---|---|---|---|
| Alta | `estudiantes-home` | `https://www.fce.unl.edu.ar/estudiantes/` | `estudiantes/overview.md` | WordPress/page | Página índice con descripción y navegación. Evitar duplicar detalles de hijas. |
| Alta | `estudiantes-examenes` | `https://www.fce.unl.edu.ar/estudiantes/examenes/` | `estudiantes/examenes.md` | WordPress/page | Reglas generales de exámenes, control de inscripciones y condiciones. |
| Alta | `estudiantes-examenes-finales` | `https://www.fce.unl.edu.ar/estudiantes/examenes-finales/` | `estudiantes/examenes-finales.md` | WordPress + enlaces a planillas | Contiene turnos/año académico. Los links a planillas deben transformarse a snapshots. |
| Alta | `estudiantes-examenes-parciales` | `https://www.fce.unl.edu.ar/estudiantes/examenes-parciales/` | `estudiantes/examenes-parciales.md` | WordPress + iframe | Requiere resolver iframe/datos embebidos si Sophia debe responder fechas. |
| Alta | `estudiantes-tramites` | `https://www.fce.unl.edu.ar/estudiantes/tramites-estudiantes/` | `estudiantes/tramites.md` | WordPress + PDFs/formularios | Contiene inscripción/desistimiento/turno castigo/certificados/elección de carrera. |
| Alta | `estudiantes-inscripciones-cursado` | `https://www.fce.unl.edu.ar/estudiantes/info-sobre-inscripciones/` | `estudiantes/inscripciones-cursado.md` | WordPress + PDFs/listados | Puede contener listados nominales; revisar privacidad antes de publicar completo. |
| Media | `estudiantes-consultas` | `https://www.fce.unl.edu.ar/estudiantes/categorias/consultas/` | `estudiantes/clases-consultas.md` | WordPress + sistema externo | Incluye link a Bedelía Móvil y reglas de consultas/muestras. |
| Media | `estudiantes-parciales-notas-muestras` | `https://www.fce.unl.edu.ar/estudiantes/parciales-entrega-de-notas-y-muestra-de-examenes/` | `estudiantes/parciales-notas-muestras.md` | Web dinámica | Requiere evaluar si los datos están en HTML, JS o sistema externo. |
| Media | `estudiantes-pai` | `https://www.fce.unl.edu.ar/estudiantes/pai/` | `estudiantes/practicas-academicas-internas.md` | WordPress/page | Bienestar estudiantil / PAI. |
| Baja | `estudiantes-centro-estudiantes` | `https://www.fce.unl.edu.ar/estudiantes/categorias/cece/` | `estudiantes/centro-estudiantes.md` | WordPress/page | Información institucional/contacto; menor impacto operativo. |

## Fuentes externas vinculadas

| Fuente | Tipo | Tratamiento propuesto |
|---|---|---|
| Google Sheets de turnos de exámenes finales | Planilla | Exportar/leer como tabla y generar `estudiantes/examenes-finales-turnos-YYYY.md` o sección estructurada en `examenes-finales.md`, según granularidad. |
| iframes de exámenes parciales | Embebido/web dinámica | Detectar URL real del iframe y convertir contenido a snapshot MD si es público y estable. |
| PDFs de instructivos/formularios | PDF | Mantener como link si solo es formulario; extraer a MD si contiene instrucciones que Sophia debe explicar. |
| SIU Guaraní / SICA / CUP / Bedelía Móvil | Sistemas externos | No scrapear datos autenticados. Sophia solo debe explicar finalidad, acceso y derivar al sistema oficial. |

## Criterios de privacidad

No publicar automáticamente:

- listados de estudiantes con nombre/apellido/DNI;
- asignaciones individuales de comisiones/electivas;
- datos que cambian por persona;
- información detrás de login;
- planillas no públicas o con permisos restringidos.

Si una página pública contiene listados nominales, el PR debe resumir reglas/cronograma general y dejar el listado como fuente consultable, pero no copiar datos personales al MD salvo aprobación explícita.

## Contrato de Markdown para `/estudiantes/`

Cada MD operativo debería usar secciones simples:

```markdown
# Título

## Para qué sirve

## Información vigente

## Pasos / cómo se hace

## Fechas importantes

## Sistemas relacionados

## Contacto

## Fuentes consultadas

---

**Última revisión automática**: YYYY-MM-DD
**Revisión humana**: pendiente
```

Para snapshots de planillas:

```markdown
# Turnos de exámenes finales — año académico YYYY

## Alcance

## Tabla normalizada

| Turno | Fecha / período | Observaciones | Fuente |
|---|---|---|---|

## Advertencias

## Fuentes consultadas
```

## Limpieza/aislamiento recomendado

1. Agregar `/estudiantes/` como carpeta vigente nueva, todavía vacía o con MDs solo cuando entren por PR.
2. Registrar fuentes candidatas en `tools/scraper/sources.json` con `strategy: "TBD"` hasta implementar extractor específico.
3. No conectar Google Sheets ni iframes al workflow automático hasta tener validación de privacidad y snapshots.
4. Separar páginas web simples de fuentes tabulares/dinámicas:
   - web simple: `fce-wordpress` o extractor derivado;
   - planilla/iframe: extractor específico con snapshot y revisión humana.

## Próximo paso recomendado

C.2: implementar extractor determinístico para páginas simples de `/estudiantes/` y generar candidatos MD, dejando Sheets/iframes como fuentes detectadas pero no publicadas hasta resolver snapshots y privacidad.
