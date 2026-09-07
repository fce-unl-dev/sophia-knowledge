import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTopicMarkdown,
  buildTeacherIndexMarkdown,
  TEACHER_INDEX_PATH,
} from '../scrape_students.mjs';

// Planilla mínima con dos docentes en materias distintas. Alcanza para verificar
// en qué documento termina cada cosa, que es lo único que se está probando acá.
const classSchedules = [
  {
    tab: 'Primer año',
    ok: true,
    schedules: [
      { docente: 'Pía Chiapero', materia: '1015 - Matemática como Lenguaje', comision: 'Com. N° 3', dia: 'Lunes', horario: '10.30 - 13.15 hs' },
      { docente: 'Marta, Nardoni', materia: '1015 - Matemática como Lenguaje', comision: 'Com. N° 2', dia: 'Martes', horario: '10.30 - 13.15 hs' },
    ],
  },
];

const resultado = (extra = {}) => ({
  topic: {
    slug: 'estudiantes-inscripciones-cursado',
    title: 'Info sobre inscripciones a cursado',
    path: 'estudiantes/inscripciones-cursado.md',
    pages: [['Info sobre inscripciones', 'https://www.fce.unl.edu.ar/estudiantes/info-sobre-inscripciones/']],
  },
  pages: [{ title: 'Info sobre inscripciones', text: 'x'.repeat(400) }],
  signals: { google_sheet_links: [], system_links: [] },
  summary: { pages_with_content: 1, requires_review: false, review_reasons: [] },
  examSchedules: null,
  classSchedules,
  links: [],
  ...extra,
});

// ── El documento grande deja de cargar el índice ─────────────────────────────

test('el documento de inscripciones ya NO trae la tabla por docente', () => {
  const md = buildTopicMarkdown(resultado(), { today: '2026-09-06' });
  assert.ok(!/^##\s+Índice por Docente/m.test(md),
    'si vuelve acá, el sector `docentes` se queda otra vez sin datos');
  assert.ok(!md.includes('| Docente | Materia | Comisión | Día y Horario |'));
});

test('pero conserva la distribución de comisiones, que sí es su tema', () => {
  const md = buildTopicMarkdown(resultado(), { today: '2026-09-06' });
  assert.match(md, /##\s+Distribución de Comisiones y Horarios/);
});

test('y deja un puntero al documento nuevo, no un hueco', () => {
  const md = buildTopicMarkdown(resultado(), { today: '2026-09-06' });
  assert.ok(md.includes('estudiantes/indice-por-docente.md'),
    'quien lea el documento tiene que poder encontrar adónde se fue la tabla');
});

// ── El documento nuevo ───────────────────────────────────────────────────────

test('el índice por docente sale como documento propio, con la tabla', () => {
  const md = buildTeacherIndexMarkdown(resultado(), { today: '2026-09-06' });
  assert.match(md, /^#\s+Índice por Docente/m);
  assert.ok(md.includes('| Docente | Materia | Comisión | Día y Horario |'));
  assert.ok(md.includes('Chiapero'));
  assert.ok(md.includes('Nardoni'));
});

test('lleva la fecha de la planilla, que es lo que dice si el dato está fresco', () => {
  const md = buildTeacherIndexMarkdown(resultado(), { today: '2026-09-06' });
  assert.ok(md.includes('**Última actualización de planilla**: 2026-09-06'));
});

test('instruye a derivar en vez de deducir cuando el apellido no figura', () => {
  const md = buildTeacherIndexMarkdown(resultado(), { today: '2026-09-06' });
  assert.match(md, /SIU Guaraní|Bedelía/);
  assert.match(md, /nunca deducir/i);
});

test('sin planillas no inventa un documento vacío', () => {
  assert.equal(buildTeacherIndexMarkdown(resultado({ classSchedules: null })), null);
  assert.equal(buildTeacherIndexMarkdown(resultado({ classSchedules: [] })), null);
});

// ── El guard de paths ────────────────────────────────────────────────────────

test('el destino queda bajo estudiantes/, que es lo que exige el propose', () => {
  // propose_students_update.mjs descarta por seguridad cualquier candidato con
  // path fuera de estudiantes/. El sector lo decide la taxonomía, no la carpeta.
  assert.ok(TEACHER_INDEX_PATH.startsWith('estudiantes/'));
  assert.ok(TEACHER_INDEX_PATH.endsWith('.md'));
});
