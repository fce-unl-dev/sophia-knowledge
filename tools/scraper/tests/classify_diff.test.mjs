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
  test('no current MD → requires_review (no_existing_md)', async () => {
    const r = await classifyDiff('# Nuevo', '', { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'no_existing_md');
  });

  test('iguales → no_change', async () => {
    const a = md({ sections: { 'A': 'x', 'Contacto': 'mail@x' } });
    const r = await classifyDiff(a, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'no_change');
  });

  test('cambio solo en sección no sensible → auto_merge', async () => {
    const a = md({ sections: { 'Plan de estudios': 'uno', 'Contacto': 'mail@x' } });
    const b = md({ sections: { 'Plan de estudios': 'uno reformulado', 'Contacto': 'mail@x' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.deepEqual(r.changed_sections, ['Plan de estudios']);
    assert.deepEqual(r.non_sensitive_changes, ['Plan de estudios']);
    assert.deepEqual(r.sensitive_changes, []);
  });

  test('cambio en sección sensible → requires_review', async () => {
    const a = md({ sections: { 'Contacto': 'mail@old' } });
    const b = md({ sections: { 'Contacto': 'mail@new' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'sensitive_section_changed');
    assert.deepEqual(r.sensitive_changes, ['Contacto']);
  });

  test('mezcla de cambios sensibles y no sensibles → requires_review', async () => {
    const a = md({ sections: { 'Plan de estudios': 'a', 'Modalidad y duración': 'b' } });
    const b = md({ sections: { 'Plan de estudios': 'A2', 'Modalidad y duración': 'B2' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.deepEqual(r.sensitive_changes, ['Modalidad y duración']);
    assert.deepEqual(r.non_sensitive_changes, ['Plan de estudios']);
  });

  test('sección agregada estructuralmente → requires_review', async () => {
    const a = md({ sections: { 'Plan de estudios': 'x' } });
    const b = md({ sections: { 'Plan de estudios': 'x', 'Nueva Sección': 'y' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'structural_change');
    assert.deepEqual(r.added_sections, ['Nueva Sección']);
  });

  test('cambio en preface (intro narrativa) cuenta como no-sensible por default', async () => {
    const a = md({ preface: 'descripción vieja', sections: { 'Plan de estudios': 'x' } });
    const b = md({ preface: 'descripción nueva con info actualizada', sections: { 'Plan de estudios': 'x' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.ok(r.changed_sections.includes('__preface__'));
  });

  test('cambio solo en lineas filtradas (revisión humana) → no_change', async () => {
    const a = '# T\n\n## A\nx\n\n**Última revisión humana**: 2026-01-01';
    const b = '# T\n\n## A\nx\n\n**Última revisión humana**: 2026-05-18';
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'no_change');
  });
});

describe('classifyDiff with Gemini IA', () => {
  const mockGeminiResponse = (decision, reason, detailed = '') => {
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  decision,
                  reason,
                  detailed_analysis: detailed
                })
              }
            ]
          }
        }
      ]
    };
  };

  test('diff de aranceles correctos aprueba con auto_merge', async () => {
    const a = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 50.000 ARS' } });
    const b = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 75.000 ARS' } });
    
    let lastUrl = '';
    let lastOptions = {};
    const fetchImpl = async (url, options) => {
      lastUrl = url;
      lastOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => mockGeminiResponse('auto_merge', 'Actualización de arancel coherente'),
      };
    };

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'Actualización de arancel coherente');
    assert.ok(lastUrl.includes('key=test-api-key'));
    assert.ok(lastUrl.includes('gemini-2.5-pro'));
  });

  test('diff con contradicciones o regresiones temporales decide requires_review', async () => {
    const a = md({ sections: { 'Próxima cohorte': 'Inicio: Agosto 2026' } });
    const b = md({ sections: { 'Próxima cohorte': 'Inicio: Agosto 2025' } }); // Regresión temporal!

    const fetchImpl = async (url, options) => {
      return {
        ok: true,
        status: 200,
        json: async () => mockGeminiResponse('requires_review', 'Regresión temporal detectada'),
      };
    };

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'Regresión temporal detectada');
  });

  test('error de la API cae correctamente al fallback de reglas', async () => {
    const a = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 50.000 ARS' } });
    const b = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 75.000 ARS' } });

    const fetchImpl = async (url, options) => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      };
    };

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    // En el fallback de reglas, 'Aranceles e inscripción' es una sección sensible,
    // por lo tanto debe dar 'requires_review'.
    assert.equal(r.decision, 'requires_review');
    assert.ok(r.reason.startsWith('gemini_failed_fallback_requires_review'));
  });
});
