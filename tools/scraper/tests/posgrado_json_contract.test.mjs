import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artTimestamp, compareFeedSnapshots, parsePosgradoFeed } from '../posgrado_json_contract.mjs';

const now = Date.parse('2026-10-06T15:00:00Z');
const generated = '2026-10-06 11:00:00';
const updated = '2026-10-05 16:00:00';
const enrollment = { estado: 'ABIERTA', esta_abierta: true, fecha_limite: '2026-11-01' };

function basicos() {
  return { schema_version: 1, origen: 'fce_unl_faq_generales', faq_id: 423,
    fecha_generacion: generated, fecha_actualizacion: updated,
    secciones: [{ titulo: 'Consultas', contenido_completo: 'Costo ARS 123', items: ['Costo ARS 123'] }] };
}

function item(kind, id = 17) {
  return { id_posgrado: id, ...(kind === 'carreras' ? { id_carrera: 9 } : {}),
    tipo: kind === 'carreras' ? 'Posgrado' : 'Curso', subtipo: kind === 'carreras' ? 'Maestría' : null,
    nombre: 'Programa', inscripcion: { ...enrollment }, fecha_actualizacion: updated,
    url_sitio_web: 'https://fce.unl.edu.ar/programa', respuesta_frecuente: 'Costo ARS 123' };
}

function feed(kind, records = [item(kind)]) {
  return { schema_version: 1, origen: `fce_unl_${kind}_posgrado`,
    fecha_generacion: generated, cantidad_registros: records.length, [kind]: records };
}

function parse(kind, value) { return parsePosgradoFeed(kind, value, { now }); }
function rejects(kind, value, code) {
  assert.throws(() => parse(kind, value), error => error.code === code);
}

test('parses all three official envelopes without stripping complete FAQ or general text', () => {
  const basic = parse('basicos', JSON.stringify(basicos()));
  assert.equal(basic.records[0].data.secciones[0].contenido_completo, 'Costo ARS 123');
  assert.equal(basic.records[0].id, 'basicos:423');
  for (const kind of ['carreras', 'cursos']) {
    const parsed = parse(kind, feed(kind));
    assert.equal(parsed.records[0].id, `${kind}:17`);
    assert.equal(parsed.records[0].data.respuesta_frecuente, 'Costo ARS 123');
    assert.equal(parsed.records[0].faqSelectionProvenance, 'not_provided');
  }
});

test('hash ignores generation and update clocks, but detects price, FAQ, or status changes', () => {
  const original = feed('cursos');
  const changedClock = structuredClone(original);
  changedClock.fecha_generacion = '2026-10-06 11:01:00';
  changedClock.cursos[0].fecha_actualizacion = '2026-10-06 10:00:00';
  assert.equal(parse('cursos', original).records[0].contentHash,
    parse('cursos', changedClock).records[0].contentHash);
  changedClock.cursos[0].respuesta_frecuente = 'Costo ARS 456';
  assert.notEqual(parse('cursos', original).records[0].contentHash,
    parse('cursos', changedClock).records[0].contentHash);
  changedClock.cursos[0].respuesta_frecuente = 'Costo ARS 123';
  changedClock.cursos[0].inscripcion = { estado: 'CERRADA', esta_abierta: false, fecha_limite: '2026-11-01' };
  assert.notEqual(parse('cursos', original).records[0].contentHash,
    parse('cursos', changedClock).records[0].contentHash);
});

test('basicos hash includes every section and item, not just the first summary', () => {
  const original = basicos();
  const revised = structuredClone(original);
  revised.secciones[0].items.push('Nueva aclaración');
  assert.notEqual(parse('basicos', original).records[0].contentHash,
    parse('basicos', revised).records[0].contentHash);
});

test('rejects unsupported schema, wrong origin, missing required arrays and count mismatch', () => {
  for (const kind of ['basicos', 'carreras', 'cursos']) {
    const value = kind === 'basicos' ? basicos() : feed(kind);
    rejects(kind, { ...value, schema_version: 2 }, 'unsupported_schema');
    rejects(kind, { ...value, origen: 'other' }, 'invalid_origin');
  }
  rejects('basicos', { ...basicos(), secciones: [] }, 'invalid_shape');
  rejects('cursos', { ...feed('cursos'), cantidad_registros: 2 }, 'count_mismatch');
  const withoutOptionalCount = feed('cursos');
  delete withoutOptionalCount.cantidad_registros;
  assert.equal(parse('cursos', withoutOptionalCount).records.length, 1);
  rejects('carreras', { ...feed('carreras'), carreras: [] , cantidad_registros: 0 }, 'invalid_shape');
  rejects('cursos', '{bad json', 'invalid_json');
});

test('rejects duplicate or invalid stable IDs before a caller can write', () => {
  rejects('cursos', feed('cursos', [item('cursos'), item('cursos')]), 'duplicate_id');
  rejects('carreras', feed('carreras', [item('carreras', 0)]), 'invalid_id');
  rejects('basicos', { ...basicos(), faq_id: '423' }, 'invalid_id');
});

test('validates ART wall times, actual calendar days and no future timestamps', () => {
  assert.equal(artTimestamp('2026-10-06 12:00:00', 'x', now), now);
  assert.equal(artTimestamp('2024-02-29 00:00:00', 'x', now), Date.parse('2024-02-29T03:00:00Z'));
  for (const timestamp of ['2026-02-29 00:00:00', '2026-13-01 00:00:00',
    '2026-10-06 24:00:00', '2026-10-06T11:00:00Z']) {
    assert.throws(() => artTimestamp(timestamp, 'x', now));
  }
  assert.throws(() => artTimestamp('2026-10-07 00:00:00', 'x', now), error => error.code === 'future_timestamp');
  rejects('cursos', { ...feed('cursos'), fecha_generacion: '2026-10-07 00:00:00' }, 'future_timestamp');
});

test('quarantines record updates newer than the feed generation timestamp', () => {
  const course = item('cursos');
  course.fecha_actualizacion = '2026-10-06 11:00:01';
  rejects('cursos', feed('cursos', [course]), 'update_after_generation');
  const general = basicos();
  general.fecha_actualizacion = '2026-10-06 11:00:01';
  rejects('basicos', general, 'update_after_generation');
});

test('rejects malformed state/boolean, invalid deadline and unsafe URL', () => {
  const broken = item('cursos');
  broken.inscripcion.esta_abierta = false;
  rejects('cursos', feed('cursos', [broken]), 'invalid_enrollment');
  broken.inscripcion.esta_abierta = true;
  broken.inscripcion.fecha_limite = '2026-11-31';
  rejects('cursos', feed('cursos', [broken]), 'invalid_date');
  broken.inscripcion.fecha_limite = '2026-11-01';
  broken.url_sitio_web = 'javascript:alert(1)';
  rejects('cursos', feed('cursos', [broken]), 'invalid_url');
  broken.url_sitio_web = 'https://fce.unl.edu.ar/programa';
  broken.inscripcion.fecha_limite = '2026-10-05';
  rejects('cursos', feed('cursos', [broken]), 'expired_open_enrollment');
  const closed = item('carreras');
  closed.inscripcion = { estado: 'CERRADA', esta_abierta: false, fecha_limite: null };
  assert.equal(parse('carreras', feed('carreras', [closed])).records[0].data.inscripcion.fecha_limite, null);
});

test('quarantines disappearance, timestamp rollback and same-revision content changes', () => {
  const previous = parse('cursos', feed('cursos'));
  const absent = parse('cursos', feed('cursos', [item('cursos', 18)]));
  assert.deepEqual(compareFeedSnapshots(previous, absent), [{ code: 'missing_record', id: 'cursos:17' }]);
  const rollback = feed('cursos');
  rollback.cursos[0].fecha_actualizacion = '2026-10-04 16:00:00';
  assert.deepEqual(compareFeedSnapshots(previous, parse('cursos', rollback)),
    [{ code: 'timestamp_regression', id: 'cursos:17' }]);
  const silentChange = feed('cursos');
  silentChange.cursos[0].respuesta_frecuente = 'Costo ARS 456';
  assert.deepEqual(compareFeedSnapshots(previous, parse('cursos', silentChange)),
    [{ code: 'content_changed_without_revision', id: 'cursos:17' }]);
  const routine = feed('cursos');
  routine.cursos[0].fecha_actualizacion = '2026-10-06 10:00:00';
  routine.cursos[0].respuesta_frecuente = 'Costo ARS 456';
  assert.deepEqual(compareFeedSnapshots(previous, parse('cursos', routine)), []);
});
