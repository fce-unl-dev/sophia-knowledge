import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_SECTIONS,
  PROHIBITED_PHRASES,
  checkStructure,
  checkProhibited,
  checkPlaceholders,
  checkClosing,
  checkSize,
  extractFontsUrls,
  checkUrls,
  validate,
} from '../validate.mjs';

function makeWellFormedMd(extra = '') {
  return [
    '# Maestría en Administración de Empresas',
    '',
    ...REQUIRED_SECTIONS.flatMap((s) => [`## ${s}`, 'contenido ' + s, '']),
    extra,
    '**Última revisión humana**: PENDIENTE — draft autogenerado el 2026-05-18 por pipeline.',
  ].join('\n');
}

describe('checkStructure', () => {
  test('MD bien formado no produce errors', () => {
    const errors = checkStructure(makeWellFormedMd());
    assert.deepEqual(errors, []);
  });

  test('detecta H1 faltante', () => {
    const md = '## Identificación\nx';
    const errors = checkStructure(md);
    assert.ok(errors.some((e) => /Falta H1/.test(e)));
  });

  test('detecta secciones faltantes', () => {
    const md = '# Título\n\n## Identificación\nx\n\n## Contacto\ny';
    const errors = checkStructure(md);
    // Faltan 8 de las 10 secciones requeridas
    assert.ok(errors.length >= 7);
    assert.ok(errors.some((e) => /Modalidad y duración/.test(e)));
  });

  test('detecta secciones fuera de orden', () => {
    // Contacto antes que Identificación
    const sections = ['Contacto', ...REQUIRED_SECTIONS.filter((s) => s !== 'Contacto')];
    const md = ['# T', '', ...sections.flatMap((s) => [`## ${s}`, '']), '**Última revisión humana**: x'].join('\n');
    const errors = checkStructure(md);
    assert.ok(errors.length > 0);
  });
});

describe('checkProhibited', () => {
  test('detecta cada frase prohibida', () => {
    for (const phrase of PROHIBITED_PHRASES) {
      const errors = checkProhibited(`hola ${phrase} chau`);
      assert.equal(errors.length, 1, `falló para "${phrase}"`);
    }
  });

  test('detecta fences markdown', () => {
    const errors = checkProhibited('```\nfoo\n```');
    assert.ok(errors.some((e) => /bloques de código/.test(e)));
  });

  test('MD limpio no produce errors', () => {
    assert.deepEqual(checkProhibited('Texto normal sin formalismos.'), []);
  });
});

describe('checkPlaceholders', () => {
  test('detecta placeholders típicos del template', () => {
    const errors = checkPlaceholders('Nombre: {Nombre largo del programa}');
    assert.equal(errors.length, 1);
  });
  test('ignora paths que tienen / dentro', () => {
    const errors = checkPlaceholders('Path: {/etc/config}');
    assert.equal(errors.length, 0);
  });
  test('limita la cantidad de errors mostrados', () => {
    const md = Array.from({ length: 10 }, (_, i) => `{Field${i}}`).join('\n');
    const errors = checkPlaceholders(md);
    assert.ok(errors.length <= 6); // 5 placeholders + 1 línea "... y N más"
  });
});

describe('checkClosing', () => {
  test('detecta cierre faltante', () => {
    assert.deepEqual(checkClosing('texto sin cierre'), ['Falta línea de cierre "**Última revisión humana**:"']);
  });
  test('acepta cierre presente', () => {
    assert.deepEqual(checkClosing('foo\n**Última revisión humana**: hoy'), []);
  });
});

describe('checkSize', () => {
  test('sin currentMd, no error ni warning', () => {
    const r = checkSize('x'.repeat(100), '');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });
  test('error si candidate es <30% del actual', () => {
    const r = checkSize('x'.repeat(20), 'y'.repeat(100));
    assert.ok(r.errors.length >= 1);
  });
  test('warning si candidate es >300% del actual', () => {
    const r = checkSize('x'.repeat(500), 'y'.repeat(100));
    assert.ok(r.warnings.length >= 1);
    assert.equal(r.errors.length, 0);
  });
  test('OK en rango normal', () => {
    const r = checkSize('x'.repeat(120), 'y'.repeat(100));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });
});

describe('extractFontsUrls', () => {
  test('extrae URLs de la sección Fuentes consultadas', () => {
    const md = [
      '# T', '',
      '## Otra sección',
      'Algo con URL https://no-debe-aparecer.com/x',
      '',
      '## Fuentes consultadas',
      '- https://fce.unl.edu.ar/mba/',
      '- https://fce.unl.edu.ar/mba/index.php?act=showSubcategoria&id=22',
    ].join('\n');
    const urls = extractFontsUrls(md);
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => u.includes('fce.unl.edu.ar')));
    assert.ok(!urls.some((u) => u.includes('no-debe-aparecer')));
  });
  test('vacío si no hay sección Fuentes consultadas', () => {
    assert.deepEqual(extractFontsUrls('# T\nsin nada'), []);
  });
});

describe('checkUrls', () => {
  test('reporta 404 como failed', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('404')) return { ok: false, status: 404 };
      return { ok: true, status: 200 };
    };
    const failed = await checkUrls(['https://x/ok', 'https://x/404'], { fetchImpl, timeoutMs: 1000 });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 404);
  });
  test('acepta 405 (HEAD no permitido pero URL existe)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 405 });
    const failed = await checkUrls(['https://x/'], { fetchImpl, timeoutMs: 1000 });
    assert.equal(failed.length, 0);
  });
  test('captura excepciones de red', async () => {
    const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
    const failed = await checkUrls(['https://invalid/'], { fetchImpl, timeoutMs: 1000 });
    assert.equal(failed.length, 1);
    assert.ok(failed[0].error);
  });
});

describe('validate (orquestador)', () => {
  test('MD bien formado con skip-network → ok:true', async () => {
    const r = await validate(makeWellFormedMd(), { skipNetwork: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  test('MD con prohibidos → ok:false', async () => {
    const md = makeWellFormedMd('\nMuchas gracias por tu interés en nuestra propuesta.');
    const r = await validate(md, { skipNetwork: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /Patrón prohibido/.test(e)));
  });

  test('integra checkSize cuando se pasa currentMd', async () => {
    const candidate = '# T\n' + REQUIRED_SECTIONS.map((s) => `## ${s}\nx`).join('\n') + '\n**Última revisión humana**: x';
    const current = 'y'.repeat(candidate.length * 5);
    const r = await validate(candidate, { currentMd: current, skipNetwork: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /muy chico/.test(e)));
  });

  test('warnings de URL no rompen ok:true', async () => {
    const md = makeWellFormedMd('\n## Fuentes consultadas\n- https://x/404\n');
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const r = await validate(md, { skipNetwork: false, fetchImpl });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /URL inválida/.test(w)));
  });
});
