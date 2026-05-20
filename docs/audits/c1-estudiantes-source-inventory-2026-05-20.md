# C.1 — Inventario de fuentes de Estudiantes

Fecha: 2026-05-20
Repositorio: `fce-unl-dev/sophia-knowledge`

## Objetivo

Incorporar la sección `https://www.fce.unl.edu.ar/estudiantes/` y sus subpáginas relevantes a la base de conocimiento de Sophia respetando la estructura real de navegación: **un MD por título/tema del menú**, con la página principal y subpáginas relacionadas dentro del mismo documento.

## Principios corregidos

- La fuente vigente para Sophia sigue siendo `indice.json` + Markdown revisado.
- Cada tema del menú de Estudiantes debe tener **un MD propio** en `/estudiantes/`.
- Si un tema tiene subpáginas relacionadas, se agrupan dentro del mismo MD.
- No se crea un MD separado por cada URL técnica si esas URLs son partes del mismo tema para el usuario.
- Se excluyen páginas obsoletas o sin contenido útil.
- Google Sheets, iframes y PDFs pueden aparecer como fuentes vinculadas, pero si Sophia debe responder sobre su contenido deben convertirse a snapshots Markdown revisados.
- Las bajas/cambios detectados se proponen por PR; no hay merge automático.

## Guía mínima de temas y links a utilizar

| Tema del menú | Slug propuesto | MD destino propuesto | Links mínimos a considerar | Estado |
|---|---|---|---|---|
| Ingreso 2026 | `estudiantes-ingreso-2026` | `estudiantes/ingreso-2026.md` | `https://www.fce.unl.edu.ar/estudiantes/ingreso-2026/` | incluir |
| Ingreso 2025 | — | — | `https://www.fce.unl.edu.ar/estudiantes/ingreso-2025/` | excluir por obsoleto |
| Trámites internos | `estudiantes-tramites-internos` | `estudiantes/tramites-internos.md` | página principal + ingresantes + estudiantes + graduados | incluir |
| Calendario Académico | `estudiantes-calendario-academico` | `estudiantes/calendario-academico.md` | categoría/página de calendario académico | incluir |
| Bienestar Estudiantil | `estudiantes-bienestar-estudiantil` | `estudiantes/bienestar-estudiantil.md` | página principal + BAPI + becas UNL + movilidad + PAI | incluir |
| Pasantías rentadas | `estudiantes-pasantias-rentadas` | `estudiantes/pasantias-rentadas.md` | página de pasantías rentadas | incluir |
| Prácticas Profesionales Supervisadas | `estudiantes-practicas-profesionales-supervisadas` | `estudiantes/practicas-profesionales-supervisadas.md` | página PPS | incluir |
| Info sobre inscripciones a cursado | `estudiantes-inscripciones-cursado` | `estudiantes/inscripciones-cursado.md` | página de inscripciones + PDFs/listados vinculados si corresponde | incluir con revisión de privacidad |
| SIU Guaraní | `estudiantes-siu-guarani` | `estudiantes/siu-guarani.md` | página SIU Guaraní + sistema externo oficial | incluir solo explicación/acceso |
| Sistema Informático de Consultas de Alumnos (SICA) | `estudiantes-sica` | `estudiantes/sica.md` | página SICA + sistema externo oficial | incluir solo explicación/acceso |
| Exámenes | `estudiantes-examenes` | `estudiantes/examenes.md` | página exámenes + finales + parciales | incluir; Sheets/iframes requieren snapshot |
| Clases de Consultas | `estudiantes-clases-consultas` | `estudiantes/clases-consultas.md` | categoría consultas + consultas para exámenes + consultas permanentes + notas/muestras + avisos | incluir |
| Centro de Estudiantes | `estudiantes-centro-estudiantes` | `estudiantes/centro-estudiantes.md` | página Centro de Estudiantes | incluir si tiene contenido útil |
| Horarios de Atención | `estudiantes-horarios-atencion` | `estudiantes/horarios-atencion.md` | página horarios de atención | incluir si tiene contenido útil |
| Beneficios para Posgrados FCE UNL | `estudiantes-beneficios-posgrados` | `estudiantes/beneficios-posgrados-fce-unl.md` | página de beneficios | incluir aunque esté dentro de Estudiantes |

## Fuentes externas vinculadas

| Fuente | Tipo | Tratamiento propuesto |
|---|---|---|
| Google Sheets de turnos de exámenes finales | Planilla | Convertir a snapshot Markdown estructurado antes de permitir respuestas sobre fechas. |
| iframes de exámenes parciales | Embebido/web dinámica | Resolver URL real y convertir a snapshot MD si es público y estable. |
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
# Título del tema

## Para qué sirve

## Información publicada

### Página principal

### Subpágina relacionada

## Enlaces y sistemas relacionados

## Advertencias para Sophia

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

1. Agregar `/estudiantes/` como carpeta vigente nueva solo cuando los MD entren por PR humano.
2. Mantener fuentes candidatas con `strategy: "TBD"` en el workflow genérico hasta que el extractor específico proponga PRs.
3. No conectar Google Sheets ni iframes a publicación automática hasta tener validación de privacidad y snapshots.
4. Agrupar por tema del menú, no por URL individual.

## Próximo paso recomendado

C.2: ajustar el extractor determinístico para generar candidatos por tema del menú y no por páginas sueltas.
