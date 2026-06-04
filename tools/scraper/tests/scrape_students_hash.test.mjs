import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { neutralizeDate } from '../scrape_students.mjs';

const h = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('neutralizeDate', () => {
  test('reemplaza TODAS las ocurrencias de la fecha de hoy por {DATE}', () => {
    assert.equal(
      neutralizeDate('Última actualización: 2026-06-04 ... revisión 2026-06-04', '2026-06-04'),
      'Última actualización: {DATE} ... revisión {DATE}'
    );
  });

  test('no falla con entradas vacías', () => {
    assert.equal(neutralizeDate('', '2026-06-04'), '');
    assert.equal(neutralizeDate('algo', ''), 'algo');
  });
});

describe('content_hash del candidato (anti-bug de auto-merge de planillas)', () => {
  // Simula el cálculo que hace runStudentsScraper: sha256(neutralizeDate(md, today)).
  const baseMd = 'Snapshot\n**Última actualización de planilla**: 2026-06-04\n| C1 | Lunes | 8 hs | Bolea |';

  test('mismo contenido en otro día → MISMO hash (no dispara PR espurio)', () => {
    const hoy = h(neutralizeDate(baseMd, '2026-06-04'));
    const manana = h(neutralizeDate(baseMd.replace('2026-06-04', '2026-06-05'), '2026-06-05'));
    assert.equal(hoy, manana);
  });

  test('cambio REAL en la planilla (mismo día) → hash DISTINTO (dispara la propuesta)', () => {
    const original = h(neutralizeDate(baseMd, '2026-06-04'));
    const cambiada = h(neutralizeDate(baseMd.replace('Lunes', 'Martes'), '2026-06-04'));
    assert.notEqual(original, cambiada);
  });

  test('cambio en el docente de una comisión → hash DISTINTO', () => {
    const original = h(neutralizeDate(baseMd, '2026-06-04'));
    const cambiada = h(neutralizeDate(baseMd.replace('Bolea', 'Coassin'), '2026-06-04'));
    assert.notEqual(original, cambiada);
  });
});
