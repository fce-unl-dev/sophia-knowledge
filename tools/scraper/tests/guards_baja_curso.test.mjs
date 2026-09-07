import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluarBajaDeCurso, parseFechaInicioPublicada } from '../guards.mjs';

const ficha = (fecha) => `# CURSO DE PRUEBA

## Identificación

- **Nombre oficial**: CURSO DE PRUEBA
- **ID de inscripción**: 9999

## Modalidad y duración

- **Fecha de inicio publicada**: ${fecha}
- **Modalidad y carga horaria**: ver detalle del programa más abajo.
`;

const HOY = new Date('2026-09-07T00:00:00Z');

// ── Parseo de la fecha ───────────────────────────────────────────────────────

test('lee la fecha de inicio publicada', () => {
  const d = parseFechaInicioPublicada(ficha('07/09/2026'));
  assert.equal(d.toISOString().slice(0, 10), '2026-09-07');
});

test('tolera un día o mes de un solo dígito', () => {
  assert.equal(parseFechaInicioPublicada(ficha('7/9/2026')).toISOString().slice(0, 10), '2026-09-07');
});

test('sin fecha legible devuelve null en vez de adivinar', () => {
  assert.equal(parseFechaInicioPublicada('# Curso sin fecha\n\nTexto suelto.'), null);
  assert.equal(parseFechaInicioPublicada(null), null);
  assert.equal(parseFechaInicioPublicada(ficha('31/02/2026')), null, 'un 31 de febrero no es una fecha');
});

// ── El caso real que motivó la guarda ────────────────────────────────────────

test('NO borra un curso que empieza hoy (el caso del PR #242)', () => {
  // Economía Gubernamental y Métodos Cuantitativos: inicio 07/09/2026, cursado
  // a distancia hasta noviembre y octubre. Salieron del listado porque cerró la
  // inscripción. El pipeline los proponía para borrar.
  const r = evaluarBajaDeCurso(ficha('07/09/2026'), { hoy: HOY });
  assert.equal(r.borrable, false);
  assert.match(r.motivo, /cerró la inscripción/);
  assert.equal(r.diasDesdeInicio, 0);
});

test('NO borra un curso que está a mitad de cursado', () => {
  const r = evaluarBajaDeCurso(ficha('01/08/2026'), { hoy: HOY });
  assert.equal(r.borrable, false);
  assert.equal(r.diasDesdeInicio, 37);
});

test('NO borra un curso que todavía no empezó, y lo marca como raro', () => {
  // Que un curso salga del listado ANTES de arrancar sí es anómalo: puede ser
  // una cancelación real, pero también un scrape degradado. Se conserva y se
  // reporta para que lo mire una persona.
  const r = evaluarBajaDeCurso(ficha('20/10/2026'), { hoy: HOY });
  assert.equal(r.borrable, false);
  assert.match(r.motivo, /todavía no empezó/);
  assert.ok(r.diasDesdeInicio < 0);
});

// ── Cuándo sí se borra ───────────────────────────────────────────────────────

test('SÍ borra una edición vencida hace más de un año', () => {
  const r = evaluarBajaDeCurso(ficha('01/06/2025'), { hoy: HOY });
  assert.equal(r.borrable, true);
  assert.match(r.motivo, /edición está vencida/);
});

test('el umbral es configurable y se respeta en el borde', () => {
  // Justo en el umbral todavía se conserva; un día más y se borra.
  assert.equal(evaluarBajaDeCurso(ficha('01/08/2026'), { hoy: HOY, diasVencido: 37 }).borrable, true);
  assert.equal(evaluarBajaDeCurso(ficha('01/08/2026'), { hoy: HOY, diasVencido: 38 }).borrable, false);
});

// ── Falla del lado seguro ────────────────────────────────────────────────────

test('sin fecha legible NO se borra', () => {
  // Preferimos una ficha vieja de más —la R3 del prompt avisa que la fecha pasó—
  // antes que perder un curso real por no poder leer una fecha.
  const r = evaluarBajaDeCurso('# Curso sin fecha\n\nTexto.', { hoy: HOY });
  assert.equal(r.borrable, false);
  assert.match(r.motivo, /no tiene una "Fecha de inicio publicada" legible/);
  assert.equal(r.diasDesdeInicio, null);
});

test('una ficha inexistente tampoco habilita el borrado', () => {
  assert.equal(evaluarBajaDeCurso(null, { hoy: HOY }).borrable, false);
});
