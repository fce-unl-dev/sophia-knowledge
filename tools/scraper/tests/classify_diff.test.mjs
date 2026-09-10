import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSections,
  normalizeForDiff,
  diffSections,
  classifyDiff,
  CLASSIFICATION_SYSTEM_INSTRUCTION,
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

describe('CLASSIFICATION_SYSTEM_INSTRUCTION', () => {
  test('permite actualizaciones rutinarias aunque toquen datos antes sensibles', () => {
    const autoMergeBlock = CLASSIFICATION_SYSTEM_INSTRUCTION
      .split('2. REQUIRES_REVIEW')[0];
    assert.match(autoMergeBlock, /aranceles/i);
    assert.match(autoMergeBlock, /contactos/i);
    assert.match(autoMergeBlock, /no presenta señales de error/i);
  });

  test('manda a revisión únicamente anomalías verificables', () => {
    const reviewBlock = CLASSIFICATION_SYSTEM_INSTRUCTION
      .split('2. REQUIRES_REVIEW')[1] || '';
    assert.match(reviewBlock, /No mandes a revisión solamente porque cambió una sección sensible/i);
    assert.match(reviewBlock, /Contradicciones internas/i);
    assert.match(reviewBlock, /error de scraping/i);
  });
});

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
  test('nueva ficha consistente → auto_merge sin auditor configurado', async () => {
    const r = await classifyDiff('# Nuevo', '', { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'no_auditor_routine_update');
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

  test('cambio rutinario en sección sensible → auto_merge', async () => {
    const a = md({ sections: { 'Contacto': 'mail@old' } });
    const b = md({ sections: { 'Contacto': 'mail@new' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'no_auditor_routine_update');
    assert.deepEqual(r.sensitive_changes, ['Contacto']);
  });

  test('mezcla de cambios rutinarios → auto_merge aunque incluya una sección sensible', async () => {
    const a = md({ sections: { 'Plan de estudios': 'a', 'Modalidad y duración': 'b' } });
    const b = md({ sections: { 'Plan de estudios': 'A2', 'Modalidad y duración': 'B2' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
    assert.deepEqual(r.sensitive_changes, ['Modalidad y duración']);
    assert.deepEqual(r.non_sensitive_changes, ['Plan de estudios']);
  });

  test('sección agregada rutinaria → auto_merge', async () => {
    const a = md({ sections: { 'Plan de estudios': 'x' } });
    const b = md({ sections: { 'Plan de estudios': 'x', 'Nueva Sección': 'y' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'auto_merge');
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

  test('contenido de error del scraper → requires_review', async () => {
    const a = md({ sections: { 'Plan de estudios': 'Contenido válido' } });
    const b = md({ sections: { 'Plan de estudios': 'Error 404 - Página no encontrada' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'scrape_error_content');
  });

  test('pérdida de un dato confirmado → requires_review', async () => {
    const a = md({ sections: { 'Modalidad y duración': '**Modalidad**: Presencial' } });
    const b = md({ sections: { 'Modalidad y duración': '**Modalidad**: Sin datos confirmados en el material consultado' } });
    const r = await classifyDiff(b, a, { sensitiveSections: SENSITIVE });
    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'destructive_information_loss');
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

  test('auto_merge del modelo sobre sección sensible rutinaria → se respeta', async () => {
    const a = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 50.000 ARS' } });
    const b = md({ sections: { 'Aranceles e inscripción': 'Cuota mensual: 75.000 ARS' } });

    let lastUrl = '';
    const fetchImpl = async (url) => {
      lastUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => mockGeminiResponse('auto_merge', 'Actualización de arancel coherente', 'El monto es legible y coherente.'),
      };
    };

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'Actualización de arancel coherente');
    assert.equal(r.ai_decision, 'auto_merge');
    assert.equal(r.ai_reason, 'Actualización de arancel coherente');
    assert.equal(r.detailed_analysis, 'El monto es legible y coherente.');
    assert.deepEqual(r.sensitive_changes, ['Aranceles e inscripción']);
    assert.ok(lastUrl.includes('key=test-api-key'));
    assert.ok(lastUrl.includes('gemini-2.5-pro'));
  });

  test('auto_merge del modelo sobre archivo nuevo consistente → se respeta', async () => {
    const b = md({ sections: { 'Plan de estudios': 'Tres años, seis materias por año' } });

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse('auto_merge', 'Ficha nueva completa y consistente'),
    });

    const r = await classifyDiff(b, '', {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'Ficha nueva completa y consistente');
    assert.equal(r.ai_decision, 'auto_merge');
    assert.ok(r.preview.includes('# Título de la ficha'));
  });

  test('auto_merge del modelo sobre secciones no sensibles → se respeta auto_merge', async () => {
    const a = md({ sections: { 'Plan de estudios': 'uno' } });
    const b = md({ sections: { 'Plan de estudios': 'uno, reformulado con más detalle' } });

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse('auto_merge', 'Reformulación del plan de estudios'),
    });

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'Reformulación del plan de estudios');
    assert.equal(r.ai_decision, 'auto_merge');
    assert.deepEqual(r.sensitive_changes, []);
  });

  test('requires_review del modelo sobre secciones no sensibles → se respeta (el override nunca ablanda)', async () => {
    const a = md({ sections: { 'Plan de estudios': 'uno' } });
    const b = md({ sections: { 'Plan de estudios': 'Error 404 - Página no encontrada' } });

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse('requires_review', 'Texto sospechoso de error de scraping'),
    });

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'requires_review');
    assert.equal(r.reason, 'scrape_error_content');
    assert.equal(r.ai_decision, undefined);
  });

  test('auto_merge del modelo sobre cambio estructural aditivo → se respeta', async () => {
    const a = md({ sections: { 'Plan de estudios': 'uno' } });
    const b = md({ sections: { 'Plan de estudios': 'uno', 'Perfil del egresado': 'nuevo bloque' } });

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse('auto_merge', 'Sección agregada sin conflictos'),
    });

    const r = await classifyDiff(b, a, {
      sensitiveSections: SENSITIVE,
      apiKey: 'test-api-key',
      fetchImpl
    });

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'Sección agregada sin conflictos');
    assert.equal(r.ai_decision, 'auto_merge');
    assert.deepEqual(r.added_sections, ['Perfil del egresado']);
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

  test('error de la API permite actualización rutinaria tras los controles deterministas', async () => {
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

    assert.equal(r.decision, 'auto_merge');
    assert.equal(r.reason, 'gemini_failed_routine_update');
  });
});
