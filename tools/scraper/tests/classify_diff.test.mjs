import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSections,
  normalizeForDiff,
  diffSections,
  classifyDiff,
} from '../classify_diff.mjs';

const SENSITIVE = [
  'Modalidad y duración',
  'Aranceles e inscripción',
  'Próxima cohorte',
  'Contacto',
  'Requisitos de admisión',
];

function md({ preface = '', sections = {} }) {
  const parts = [];
  parts.push('# Título de la ficha');
  if (preface) parts.push('', preface);
  for (const [name, body] of Object.entries(sections)) {
    parts.push('', `## ${name}`, body);
  }
  return parts.join('\n');
}

describe('parseSections', () => {
  test('separa secciones por ## y captura preface', () => {
    const m = md({ preface: 'intro narrativa', sections: { 'Identificación': 'cuerpo id', 'Contacto': 'mail@x' } });
    const s = parseSections(m);
    assert.ok(s.get('__preface__').includes('intro narrativa'));
    assert.ok(s.get('Identificación').includes('cuerpo id'));
    assert.equal(s.get('Contacto'), 'mail@x');
  });
});

describe('normalizeForDiff', () => {
  test('elimina líneas de revisión humana y fechas de actualización', () => {
    const t = 'hola\n**Última revisión humana**: hoy\nchau\n**Última actualización del dato**: 2026-01-01';
    assert.equal(normalizeForDiff(t), 'hola chau');
  });
  test('colapsa whitespace', () => {
    assert.equal(normalizeForDiff('a   b\n\nc'), 'a b c');
  });
});

describe('diffSections', () => {
  test('detecta cambio en una sección', () => {
    const a = parseSections(md({ sections: { 'A': 'uno', 'B': 'dos' } }));
    const b = parseSections(md({ sections: { 'A': 'uno', 'B': 'DOS-modificado' } }));
    const r = diffSections(a, b);
    assert.deepEqual(r.changed, ['B']);
  });

  test('detecta sección agregada y removida', () => {
    const a = parseSections(md({ sections: { 'A': 'x', 'NUEVA': 'y' } }));
    const b = parseSections(md({ sections: { 'A': 'x', 'VIEJA': 'z' } }));
    const r = diffSections(a, b);
    assert.deepEqual(r.added.sort(), ['NUEVA']);
    assert.deepEqual(r.removed.sort(), ['VIEJA']);
  });

  test('cambio en preface se reporta', () => {
    const a = parseSections(md({ preface: 'intro vieja', sections: { 'A': 'x' } }));
    const b = parseSections(md({ preface: 'intro nueva', sections: { 'A': 'x' } }));
    const r = diffSections(a, b);
    assert.ok(r.changed.includes('__preface__'));
  });

  test('ignora cambios solo de whitespace', () => {
    const a = parseSections(md({ sections: { 'A': 'uno dos tres' } }));
    const b = parseSections(md({ sections: { 'A': 'uno   dos\n\ntres' } }));
    const r = diffSections(a, b);
    assert.deepEqual(r.changed, []);
  });
});

describe('classifyDiff', () => {
  test('no current MD → requires_review (no_existing_md)', () => {
    const r = classifyDiff('# Nuevo', '', { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'no_existing_md');
  });

  test('iguales → no_change', () => {
    const a = md({ sections: { 'A': 'x', 'Contacto': 'mail@x' } });
    const r = classifyDiff(a, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'no_change');
  });

  test('cambio solo en sección no sensible → auto_merge', () => {
    const a = md({ sections: { 'Plan de estudios': 'uno', 'Contacto': 'mail@x' } });
    const b = md({ sections: { 'Plan de estudios': 'uno reformulado', 'Contacto': 'mail@x' } });
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.deepEqual(r.changed_sections, ['Plan de estudios']);
    assert.deepEqual(r.non_sensitive_changes, ['Plan de estudios']);
    assert.deepEqual(r.sensitive_changes, []);
  });

  test('cambio en sección sensible → requires_review', () => {
    const a = md({ sections: { 'Contacto': 'mail@old' } });
    const b = md({ sections: { 'Contacto': 'mail@new' } });
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'sensitive_section_changed');
    assert.deepEqual(r.sensitive_changes, ['Contacto']);
  });

  test('mezcla de cambios sensibles y no sensibles → requires_review', () => {
    const a = md({ sections: { 'Plan de estudios': 'a', 'Modalidad y duración': 'b' } });
    const b = md({ sections: { 'Plan de estudios': 'A2', 'Modalidad y duración': 'B2' } });
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.deepEqual(r.sensitive_changes, ['Modalidad y duración']);
    assert.deepEqual(r.non_sensitive_changes, ['Plan de estudios']);
  });

  test('sección agregada estructuralmente → requires_review', () => {
    const a = md({ sections: { 'Plan de estudios': 'x' } });
    const b = md({ sections: { 'Plan de estudios': 'x', 'Nueva Sección': 'y' } });
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'structural_change');
    assert.deepEqual(r.added_sections, ['Nueva Sección']);
  });

  test('cambio en preface (intro narrativa) cuenta como no-sensible por default', () => {
    const a = md({ preface: 'descripción vieja', sections: { 'Plan de estudios': 'x' } });
    const b = md({ preface: 'descripción nueva con info actualizada', sections: { 'Plan de estudios': 'x' } });
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.ok(r.changed_sections.includes('__preface__'));
  });

  test('cambio solo en lineas filtradas (revisión humana) → no_change', () => {
    const a = '# T\n\n## A\nx\n\n**Última revisión humana**: 2026-01-01';
    const b = '# T\n\n## A\nx\n\n**Última revisión humana**: 2026-05-18';
    const r = classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'no_change');
  });
});
