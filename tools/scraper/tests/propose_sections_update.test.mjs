import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  proposeSectionsUpdate,
  normalizeSectionPath,
  insertSectionEntries,
} from '../propose_sections_update.mjs';

const TAXONOMY = {
  sectors: {
    academica: { displayName: 'Académica', kbFolder: 'academica', webPathPrefixes: ['/academica'] },
  },
};

// HTML de una página WordPress del theme FCE: el contenido vive en .blog-content.
function wpHtml({ title = 'Página', body = '', links = [] } = {}) {
  const anchors = links.map((h) => `<a href="${h}">link</a>`).join('\n');
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <div class="blog-content"><h1>${title}</h1><p>${body}</p>${anchors}</div>
    <footer>pie</footer></body></html>`;
}

const LONG_BODY = 'Información institucional relevante del sector académico. '.repeat(8); // >200 chars

// Mock fetch: matchea por URL normalizada (sin trailing slash) contra un mapa.
function mockFetch(map) {
  const norm = (u) => u.replace(/\/+$/, '');
  const table = new Map(Object.entries(map).map(([k, v]) => [norm(k), v]));
  return async (url) => {
    const html = table.get(norm(url));
    if (html === undefined) throw new Error(`mock fetch: no entry for ${url}`);
    return { ok: true, status: 200, url, async text() { return html; } };
  };
}

async function makeKbRoot(indexItems = []) {
  const dir = await mkdtemp(join(tmpdir(), 'sections-kb-'));
  const index = { version: 1, lastUpdated: '2026-01-01', items: indexItems };
  await writeFile(join(dir, 'indice.json'), JSON.stringify(index, null, 2), 'utf8');
  return dir;
}

const SOURCE = {
  slug: 'academica',
  sectionId: 'academica',
  url: 'https://fce.unl.edu.ar/academica/',
  strategy: 'fce-wordpress-section',
  sectionPrefix: '/academica',
  maxPages: 80,
  maxDepth: 3,
};

describe('normalizeSectionPath', () => {
  test('acepta path dentro del kbFolder y .md', () => {
    assert.equal(normalizeSectionPath('academica/calendario.md', 'academica'), 'academica/calendario.md');
  });
  test('quita prefijo ./', () => {
    assert.equal(normalizeSectionPath('./academica/x.md', 'academica'), 'academica/x.md');
  });
  test('rechaza path fuera del kbFolder', () => {
    assert.equal(normalizeSectionPath('otros/x.md', 'academica'), null);
  });
  test('rechaza traversal y doble slash', () => {
    assert.equal(normalizeSectionPath('academica/../x.md', 'academica'), null);
    assert.equal(normalizeSectionPath('academica//x.md', 'academica'), null);
  });
  test('rechaza no-.md', () => {
    assert.equal(normalizeSectionPath('academica/x.txt', 'academica'), null);
  });
});

describe('insertSectionEntries', () => {
  test('agrupa tras la última entrada del mismo folder', () => {
    const items = [
      { path: 'academica/a.md' },
      { path: 'posgrados/p.md' },
      { path: 'academica/b.md' },
    ];
    const out = insertSectionEntries(items, [{ path: 'academica/c.md' }]);
    // c.md debe quedar justo después de b.md (última academica/), no al final.
    const idxB = out.findIndex((e) => e.path === 'academica/b.md');
    assert.equal(out[idxB + 1].path, 'academica/c.md');
  });
  test('si el folder no existe en el índice, agrega al final', () => {
    const items = [{ path: 'posgrados/p.md' }];
    const out = insertSectionEntries(items, [{ path: 'academica/a.md' }]);
    assert.equal(out[out.length - 1].path, 'academica/a.md');
  });
  test('sin entradas nuevas devuelve la lista igual', () => {
    const items = [{ path: 'x/a.md' }];
    assert.equal(insertSectionEntries(items, []), items);
  });
});

describe('proposeSectionsUpdate', () => {
  test('sección sin fuente configurada → rejected', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY, sources: [], today: '2026-05-29', dryRun: true,
        fetchImpl: mockFetch({}),
      });
      assert.equal(out.ok, false);
      assert.equal(out.decision, 'rejected');
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });

  test('página importante → crea MD + entrada de índice con category del sector', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY, sources: [SOURCE], today: '2026-05-29', dryRun: true,
        fetchImpl: mockFetch({ 'https://fce.unl.edu.ar/academica/': wpHtml({ title: 'Académica', body: LONG_BODY }) }),
      });
      assert.equal(out.ok, true);
      assert.ok(out.created_docs.includes('academica/academica.md'));
      assert.ok(out.added_index_entries.includes('academica/academica.md'));
      // sin GEMINI_API_KEY, un MD nuevo → requires_review (no_existing_md).
      assert.equal(out.decision, 'requires_review');
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });

  test('root flaco sin contenido propio → genera landing (no se pierde la rama)', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY, sources: [SOURCE], today: '2026-05-29', dryRun: true,
        // root flaco: no genera MD de contenido, pero sí un landing que preserva la rama.
        fetchImpl: mockFetch({ 'https://fce.unl.edu.ar/academica/': wpHtml({ title: 'Académica', body: 'corto' }) }),
      });
      assert.equal(out.ok, true);
      assert.equal(out.candidates_count, 1);
      assert.ok(out.created_docs.includes('academica/academica.md'));
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });

  test('crawl truncado → decisión requires_review y truncated:true', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY,
        sources: [{ ...SOURCE, maxPages: 1 }], // solo baja la root; el link queda pendiente
        today: '2026-05-29', dryRun: true,
        fetchImpl: mockFetch({
          'https://fce.unl.edu.ar/academica/': wpHtml({ title: 'Académica', body: LONG_BODY, links: ['/academica/sub'] }),
        }),
      });
      assert.equal(out.truncated, true);
      assert.equal(out.decision, 'requires_review');
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });

  test('sectionId desconocido en taxonomy → unsafe_skipped → rejected', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY,
        sources: [{ ...SOURCE, sectionId: 'inexistente' }],
        today: '2026-05-29', dryRun: true,
        fetchImpl: mockFetch({ 'https://fce.unl.edu.ar/academica/': wpHtml({ title: 'X', body: LONG_BODY }) }),
      });
      assert.equal(out.ok, false);
      assert.equal(out.decision, 'rejected');
      assert.ok(out.unsafe_skipped.some((u) => /desconocido/.test(u.reason)));
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });

  test('no-dryRun escribe el MD y agrega la entrada al indice.json', async () => {
    const kbRoot = await makeKbRoot();
    try {
      const out = await proposeSectionsUpdate({
        kbRoot, taxonomy: TAXONOMY, sources: [SOURCE], today: '2026-05-29', dryRun: false, regenerateRouting: false,
        fetchImpl: mockFetch({ 'https://fce.unl.edu.ar/academica/': wpHtml({ title: 'Académica', body: LONG_BODY }) }),
      });
      assert.equal(out.ok, true);
      const md = await readFile(join(kbRoot, 'academica', 'academica.md'), 'utf8');
      assert.match(md, /# Académica/);
      const index = JSON.parse(await readFile(join(kbRoot, 'indice.json'), 'utf8'));
      const entry = index.items.find((e) => e.path === 'academica/academica.md');
      assert.ok(entry);
      assert.equal(entry.category, 'Académica');
      assert.equal(entry.canonicalUrl, 'https://fce.unl.edu.ar/academica');
    } finally {
      await rm(kbRoot, { recursive: true, force: true });
    }
  });
});
