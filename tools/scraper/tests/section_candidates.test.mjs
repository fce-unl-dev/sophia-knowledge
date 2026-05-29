import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugify,
  cleanTextLength,
  detectPossiblePersonalData,
  deriveSectionDoc,
  isCategoryArchiveUrl,
  buildSectionCandidateMarkdown,
  buildSectionLandingMarkdown,
  buildSectionCandidates,
  todayIso,
} from '../section_candidates.mjs';

// Taxonomía mínima de prueba: un sector con prefijo /academica y kbFolder academica.
const TAXONOMY = {
  sectors: {
    academica: {
      displayName: 'Académica',
      kbFolder: 'academica',
      webPathPrefixes: ['/academica'],
    },
  },
};

const TODAY = '2026-05-29';

// Helper: arma una página fake con texto de longitud controlada.
function page(url, { title = '', text = '', error = null } = {}) {
  return { url, title, text, ...(error ? { error } : {}) };
}

// Texto largo (supera el umbral de 200 chars reales).
const LONG = 'Lorem ipsum dolor sit amet. '.repeat(20); // ~560 chars

describe('slugify', () => {
  test('quita acentos y normaliza a kebab-case', () => {
    assert.equal(slugify('Información Académica'), 'informacion-academica');
  });
  test('colapsa separadores y recorta guiones', () => {
    assert.equal(slugify('  Hola / Mundo!! '), 'hola-mundo');
  });
  test('fallback a "index" cuando queda vacío', () => {
    assert.equal(slugify('   '), 'index');
    assert.equal(slugify('@#$%'), 'index');
  });
});

describe('cleanTextLength', () => {
  test('colapsa whitespace y cuenta longitud real', () => {
    assert.equal(cleanTextLength('  a   b\n\nc  '), 5); // "a b c"
  });
  test('texto vacío o nullish → 0', () => {
    assert.equal(cleanTextLength(''), 0);
    assert.equal(cleanTextLength(null), 0);
    assert.equal(cleanTextLength(undefined), 0);
  });
});

describe('detectPossiblePersonalData', () => {
  test('detecta "nombre y apellido"', () => {
    assert.equal(detectPossiblePersonalData('Complete con nombre y apellido'), true);
  });
  test('detecta DNI/documento junto a listado nominal', () => {
    assert.equal(detectPossiblePersonalData('Listado de alumnos con DNI'), true);
    assert.equal(detectPossiblePersonalData('Nómina de inscriptos y su documento'), true);
  });
  test('NO marca DNI suelto sin contexto de listado', () => {
    assert.equal(detectPossiblePersonalData('Presentar el DNI en bedelía'), false);
  });
  test('texto sin señales → false', () => {
    assert.equal(detectPossiblePersonalData('Información general del sector'), false);
  });
});

describe('deriveSectionDoc', () => {
  const sector = TAXONOMY.sectors.academica;
  const opts = { sectionId: 'academica', sector, prefix: '/academica' };

  test('raíz de la rama → slugBase = sectionId', () => {
    const out = deriveSectionDoc('https://fce.unl.edu.ar/academica', opts);
    assert.equal(out.slug, 'academica-academica');
    assert.equal(out.indice_path, 'academica/academica.md');
  });
  test('raíz con trailing slash se trata igual que sin slash', () => {
    const out = deriveSectionDoc('https://fce.unl.edu.ar/academica/', opts);
    assert.equal(out.indice_path, 'academica/academica.md');
  });
  test('subpágina simple deriva slug del segmento', () => {
    const out = deriveSectionDoc('https://fce.unl.edu.ar/academica/calendario', opts);
    assert.equal(out.slug, 'academica-calendario');
    assert.equal(out.indice_path, 'academica/calendario.md');
  });
  test('filtra el segmento de ruido "categorias"', () => {
    const out = deriveSectionDoc('https://fce.unl.edu.ar/academica/categorias/propuesta', opts);
    assert.equal(out.indice_path, 'academica/propuesta.md');
  });
  test('subpágina anidada une segmentos con guion', () => {
    const out = deriveSectionDoc('https://fce.unl.edu.ar/academica/propuesta/grado', opts);
    assert.equal(out.indice_path, 'academica/propuesta-grado.md');
  });
});

describe('isCategoryArchiveUrl', () => {
  const sector = TAXONOMY.sectors.academica;
  const opts = { sectionId: 'academica', sector, prefix: '/academica' };

  test('detecta URL con segmento /categorias/', () => {
    assert.equal(isCategoryArchiveUrl('https://fce.unl.edu.ar/academica/categorias/reglamentaciones/', opts), true);
  });
  test('el índice de categorías también es archive', () => {
    assert.equal(isCategoryArchiveUrl('https://fce.unl.edu.ar/academica/categorias/', opts), true);
  });
  test('post real (sin /categorias/) NO es archive', () => {
    assert.equal(isCategoryArchiveUrl('https://fce.unl.edu.ar/academica/reglamentaciones/', opts), false);
  });
  test('raíz de la rama NO es archive', () => {
    assert.equal(isCategoryArchiveUrl('https://fce.unl.edu.ar/academica/', opts), false);
  });
});

describe('buildSectionCandidateMarkdown', () => {
  const sector = TAXONOMY.sectors.academica;

  test('incluye título, secciones base y footer de revisión', () => {
    const md = buildSectionCandidateMarkdown({
      page: page('https://fce.unl.edu.ar/academica/calendario', { title: 'Calendario', text: 'Fecha de inicio: marzo.' }),
      sector, today: TODAY,
    });
    assert.match(md, /^# Calendario/);
    assert.match(md, /## Para qué sirve/);
    assert.match(md, /## Información publicada/);
    assert.match(md, /## Advertencias para Sophia/);
    assert.match(md, /## Fuentes consultadas/);
    assert.match(md, /\*\*Revisión humana\*\*: pendiente/);
    assert.match(md, /2026-05-29/);
  });

  test('sin reviewReasons indica que igual requiere revisión humana', () => {
    const md = buildSectionCandidateMarkdown({
      page: page('u', { title: 'T', text: 'x' }), sector, today: TODAY, reviewReasons: [],
    });
    assert.match(md, /No se detectaron señales automáticas de datos personales/);
  });

  test('con reviewReasons las lista', () => {
    const md = buildSectionCandidateMarkdown({
      page: page('u', { title: 'T', text: 'x' }), sector, today: TODAY,
      reviewReasons: ['posibles datos personales/listados nominales'],
    });
    assert.match(md, /Requiere revisión humana: posibles datos personales/);
  });

  test('appendix en root agrega enlaces no ingeridos', () => {
    const md = buildSectionCandidateMarkdown({
      page: page('u', { title: 'T', text: 'x' }), sector, today: TODAY,
      appendix: { documentLinks: ['https://fce.unl.edu.ar/doc.pdf'], lowContent: [], pendingLinks: [], errored: [], truncated: false },
    });
    assert.match(md, /## Enlaces relacionados \(no ingeridos\)/);
    assert.match(md, /doc\.pdf/);
  });
});

describe('buildSectionLandingMarkdown', () => {
  test('genera landing con enlaces y aviso de no ingesta', () => {
    const md = buildSectionLandingMarkdown({
      sector: TAXONOMY.sectors.academica, today: TODAY,
      documentLinks: ['https://fce.unl.edu.ar/planilla.xlsx'],
    });
    assert.match(md, /^# Académica/);
    assert.match(md, /planilla\.xlsx/);
    assert.match(md, /landing de sección/);
  });
});

describe('buildSectionCandidates', () => {
  const baseOpts = { sectionId: 'academica', taxonomy: TAXONOMY, today: TODAY };

  test('1 candidato por subpágina importante (≥ umbral)', () => {
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: LONG }),
        page('https://fce.unl.edu.ar/academica/calendario', { title: 'Calendario', text: LONG }),
      ],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.important_count, 2);
    assert.equal(out.candidates.length, 2);
    assert.equal(out.candidates.some((c) => c.is_root), true);
  });

  test('páginas flacas no generan MD propio, van al apéndice del root', () => {
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: LONG }),
        page('https://fce.unl.edu.ar/academica/flaca', { title: 'Flaca', text: 'corto' }),
      ],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.important_count, 1);
    assert.equal(out.low_content_count, 1);
    assert.equal(out.candidates.length, 1);
    const root = out.candidates.find((c) => c.is_root);
    assert.match(root.markdown, /Flaca/);
  });

  test('si el root no es importante pero hay material de enlaces → landing', () => {
    const result = {
      pages: [page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: 'corto' })],
      documentLinks: ['https://fce.unl.edu.ar/doc.pdf'],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.important_count, 0);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].is_root, true);
    assert.match(out.candidates[0].markdown, /landing de sección/);
  });

  test('datos personales → requires_review con razón', () => {
    const result = {
      pages: [page('https://fce.unl.edu.ar/academica/listado', {
        title: 'Listado', text: LONG + ' Listado de alumnos con DNI.',
      })],
    };
    const out = buildSectionCandidates(result, baseOpts);
    const c = out.candidates[0];
    assert.equal(c.requires_review, true);
    assert.match(c.review_reasons.join(' '), /datos personales/);
  });

  test('páginas de categoría (/categorias/) se excluyen: no generan MD ni colisionan', () => {
    // El archive de categoría comparte slug con el post real; antes colisionaban
    // y el listado pisaba al contenido. Ahora el archive se excluye del set.
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica/reglamentaciones', { title: 'A', text: LONG }),
        page('https://fce.unl.edu.ar/academica/categorias/reglamentaciones', { title: 'B', text: LONG }),
      ],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.category_archive_count, 1);
    assert.equal(out.important_count, 1);
    assert.equal(out.path_collisions.length, 0);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].indice_path, 'academica/reglamentaciones.md');
  });

  test('document_links se preservan aunque la subpágina sea de categoría', () => {
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: LONG }),
        page('https://fce.unl.edu.ar/academica/categorias/x', { title: 'Cat', text: LONG }),
      ],
      documentLinks: ['https://fce.unl.edu.ar/reg.pdf'],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.category_archive_count, 1);
    assert.deepEqual(out.document_links, ['https://fce.unl.edu.ar/reg.pdf']);
    assert.equal(out.candidates.length, 1); // sólo el root
  });

  test('colisión de ruta genuina → requires_review y se registra', () => {
    // Dos subpáginas reales distintas que derivan el mismo indice_path:
    // /propuesta-grado y /propuesta/grado → ambos 'propuesta-grado.md'.
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica/propuesta-grado', { title: 'A', text: LONG }),
        page('https://fce.unl.edu.ar/academica/propuesta/grado', { title: 'B', text: LONG }),
      ],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.path_collisions.length, 1);
    const collided = out.candidates.find((c) => c.review_reasons.some((r) => /colisión/.test(r)));
    assert.equal(collided.requires_review, true);
  });

  test('propaga truncated, pending y document links', () => {
    const result = {
      pages: [page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: LONG })],
      documentLinks: ['https://fce.unl.edu.ar/doc.pdf'],
      pendingLinks: ['https://fce.unl.edu.ar/academica/no-bajada'],
      truncated: true,
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.document_links, ['https://fce.unl.edu.ar/doc.pdf']);
    assert.deepEqual(out.pending_links, ['https://fce.unl.edu.ar/academica/no-bajada']);
    const root = out.candidates.find((c) => c.is_root);
    assert.match(root.markdown, /Crawl truncado/);
    assert.match(root.markdown, /no-bajada/);
  });

  test('páginas con error se cuentan y se listan como no descargadas', () => {
    const result = {
      pages: [
        page('https://fce.unl.edu.ar/academica', { title: 'Académica', text: LONG }),
        page('https://fce.unl.edu.ar/academica/rota', { error: 'HTTP 500' }),
      ],
    };
    const out = buildSectionCandidates(result, baseOpts);
    assert.equal(out.errored_count, 1);
    const root = out.candidates.find((c) => c.is_root);
    assert.match(root.markdown, /no se pudieron descargar/);
    assert.match(root.markdown, /rota/);
  });

  test('sector desconocido lanza error', () => {
    assert.throws(
      () => buildSectionCandidates({ pages: [] }, { sectionId: 'inexistente', taxonomy: TAXONOMY, today: TODAY }),
      /sector desconocido/,
    );
  });
});

describe('todayIso', () => {
  test('devuelve formato YYYY-MM-DD', () => {
    assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
