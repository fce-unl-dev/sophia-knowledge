import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseScheduleCsv } from '../scrape_sheets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, 'fixtures/schedules', name), 'utf8');
const materiasDe = (entries, sub) => [...new Set(
  entries.filter(e => (e.docente || '').toLowerCase().includes(sub.toLowerCase())).map(e => e.materia)
)];

// Fixtures = CSV REALES bajados de la planilla oficial de cursado (junio 2026).
describe('parseScheduleCsv — Cuarto año (materias apiladas en vertical)', () => {
  const entries = parseScheduleCsv(fx('cuarto.csv'), 'Cuarto año');

  test('Fumis está en Matemática Financiera, NO en Teoría y Técnica Impositiva', () => {
    const mats = materiasDe(entries, 'Fumis');
    assert.ok(mats.some(m => /Matem.tica Financiera/i.test(m)), `esperaba Matemática Financiera, dio: ${JSON.stringify(mats)}`);
    assert.ok(!mats.some(m => /Teor.a y T.cnica Impositiva/i.test(m)), `NO debía dar TyT Impositiva, dio: ${JSON.stringify(mats)}`);
  });

  test('Stringhini/Veglia en Teoría y Técnica Impositiva I', () => {
    assert.ok(materiasDe(entries, 'Stringhini').some(m => /Teor.a y T.cnica Impositiva/i.test(m)));
  });

  test('Mejías en Administración Pública', () => {
    assert.ok(materiasDe(entries, 'Mejías').some(m => /Administraci.n P.blica/i.test(m)));
  });

  test('detecta muchas materias distintas (no todo bajo la primera)', () => {
    const materias = [...new Set(entries.map(e => e.materia))];
    assert.ok(materias.length >= 10, `esperaba >=10 materias, hubo ${materias.length}: ${JSON.stringify(materias)}`);
  });

  test('ninguna entry queda sin nombre de materia', () => {
    assert.equal(entries.filter(e => e.materia === 'Materia sin nombre').length, 0);
  });

  test('no genera comisiones-basura de notas (- Anual -, - Selección -, etc.)', () => {
    const basura = entries.filter(e => !/^com\.?\s*(n°|nº|nro)?\s*\d+/i.test(e.comision));
    assert.equal(basura.length, 0, `comisiones inválidas: ${JSON.stringify(basura.slice(0, 5))}`);
  });
});

describe('parseScheduleCsv — Ingresantes (materias en horizontal, lado a lado)', () => {
  const entries = parseScheduleCsv(fx('ingresantes.csv'), 'Ingresantes');

  test('detecta varias materias distintas en columnas', () => {
    const materias = [...new Set(entries.map(e => e.materia))];
    assert.ok(materias.length >= 4, `materias: ${JSON.stringify(materias)}`);
  });

  test('Patricia Gomila en Contabilidad I', () => {
    assert.ok(materiasDe(entries, 'Gomila').some(m => /Contabilidad I\b/i.test(m)));
  });
});

describe('parseScheduleCsv — Segundo año (vertical)', () => {
  const entries = parseScheduleCsv(fx('segundo.csv'), 'Segundo año');
  test('detecta varias materias y atribuye docentes', () => {
    assert.ok([...new Set(entries.map(e => e.materia))].length >= 2);
    assert.ok(entries.length > 0 && entries.every(e => e.materia && e.materia !== 'Materia sin nombre'));
  });
});
