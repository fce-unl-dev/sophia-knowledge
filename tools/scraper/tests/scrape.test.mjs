import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readFile as _r, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeEntities,
  htmlToText,
  extractTitle,
  extractSectionTitle,
  cropMainContent,
  discoverFceMicrositeLinks,
  processPage,
  formatRawText,
  hashContent,
  scrapeBySource,
  runForSource,
  extractWordpressBlogContent,
} from '../scrape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

async function loadFixture(name) {
  return readFile(join(FIXTURES, name), 'utf8');
}

// Builder de un fetch mock: dado un mapa { url → html }, devuelve fetch que matchea por prefix
function buildMockFetch(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.startsWith(k));
    if (!key) throw new Error(`mock fetch: no entry for ${url}`);
    return {
      ok: true,
      status: 200,
      url,
      async text() { return map[key]; },
    };
  };
}

describe('decodeEntities', () => {
  test('decodifica nombrados comunes', () => {
    assert.equal(decodeEntities('Administraci&oacute;n'), 'Administración');
    assert.equal(decodeEntities('Espa&ntilde;ol'), 'Español');
    assert.equal(decodeEntities('&laquo;hola&raquo;'), '«hola»');
  });
  test('decodifica numéricos decimal y hex', () => {
    assert.equal(decodeEntities('&#225;'), 'á');
    assert.equal(decodeEntities('&#xE1;'), 'á');
  });
  test('preserva entities desconocidas', () => {
    assert.equal(decodeEntities('&desconocido;'), '&desconocido;');
  });
});

describe('htmlToText', () => {
  test('elimina script y style', () => {
    const out = htmlToText('<p>hola</p><script>malicious()</script><style>a{}</style>');
    assert.equal(out.includes('malicious'), false);
    assert.equal(out.includes('a{}'), false);
    assert.equal(out.includes('hola'), true);
  });
  test('convierte br y bloques en saltos', () => {
    const out = htmlToText('<p>uno</p><p>dos</p><br>tres');
    assert.match(out, /uno\s*\n+\s*dos\s*\n+\s*tres/);
  });
  test('decodifica entities dentro del texto', () => {
    const out = htmlToText('<p>Administraci&oacute;n</p>');
    assert.equal(out.trim(), 'Administración');
  });
});

describe('extractTitle', () => {
  test('extrae title decodificando', () => {
    assert.equal(extractTitle('<html><head><title>Maestr&iacute;a</title></head></html>'), 'Maestría');
  });
  test('devuelve vacío si no hay title', () => {
    assert.equal(extractTitle('<html></html>'), '');
  });
});

describe('extractSectionTitle', () => {
  test('prefiere h1 sobre h2', () => {
    assert.equal(extractSectionTitle('<h1>Uno</h1><h2>Dos</h2>'), 'Uno');
  });
  test('cae a h2 si no hay h1', () => {
    assert.equal(extractSectionTitle('<div><h2>Solo H2</h2></div>'), 'Solo H2');
  });
  test('decodifica entities', () => {
    assert.equal(extractSectionTitle('<h1>Modalidad y duraci&oacute;n</h1>'), 'Modalidad y duración');
  });
  test('vacío si no hay headings', () => {
    assert.equal(extractSectionTitle('<p>nada</p>'), '');
  });
});

describe('htmlToText elimina bullets vacíos', () => {
  test('filtra líneas que son solo guión', () => {
    const out = htmlToText('<ul><li></li><li></li><li>real</li></ul>');
    assert.equal(out.includes('- real'), true);
    // No deben quedar líneas con solo '-'
    assert.ok(!out.split('\n').some((l) => l.trim() === '-'));
  });
});

describe('cropMainContent', () => {
  test('corta antes del footer', () => {
    const html = '<main>contenido</main><footer>basura</footer>';
    const out = cropMainContent(html);
    assert.ok(out.includes('contenido'));
    assert.ok(!out.includes('basura'));
  });
  test('corta antes del div#widgets', () => {
    const html = '<main>contenido</main><div id="widgets">basura</div>';
    const out = cropMainContent(html);
    assert.ok(!out.includes('basura'));
  });
  test('si no hay marker, devuelve todo', () => {
    const html = '<main>todo</main>';
    assert.equal(cropMainContent(html), html);
  });
});

describe('discoverFceMicrositeLinks', () => {
  test('extrae links del menú con showSubcategoria y showCategoria', async () => {
    const html = await loadFixture('microsite-home.html');
    const links = discoverFceMicrositeLinks(html, 'https://fce.unl.edu.ar/mba/');
    assert.equal(links.length, 4);
    assert.ok(links[0].includes('id=40'));
    assert.ok(links[0].startsWith('https://fce.unl.edu.ar/mba/'));
    // No incluye el link externo
    assert.ok(!links.some((u) => u.includes('unrelated.com')));
  });
  test('absolutiza hrefs relativos respecto a baseUrl', () => {
    const html = '<a href="index.php?act=showSubcategoria&amp;id=9">x</a>';
    const links = discoverFceMicrositeLinks(html, 'https://fce.unl.edu.ar/maf/');
    assert.deepEqual(links, ['https://fce.unl.edu.ar/maf/index.php?act=showSubcategoria&id=9']);
  });
  test('dedup de hrefs iguales', () => {
    const html = '<a href="index.php?act=showSubcategoria&amp;id=9">a</a><a href="index.php?act=showSubcategoria&amp;id=9">b</a>';
    const links = discoverFceMicrositeLinks(html, 'https://fce.unl.edu.ar/mba/');
    assert.equal(links.length, 1);
  });
});

describe('extractWordpressBlogContent', () => {
  test('extrae sólo el contenido dentro de div.blog-content (HTML raw, sin decode)', async () => {
    const html = await loadFixture('wordpress-page.html');
    const out = extractWordpressBlogContent(html);
    // El output es HTML crudo — entities sin decodificar (decode lo hace htmlToText después).
    assert.ok(out.includes('Normas y Procedimientos'));
    assert.ok(out.includes('Inscripci&oacute;n a materias'));
    // Sidebar y footer quedan fuera por los end-markers
    assert.ok(!out.includes('NO DEBE APARECER'));
    assert.ok(!out.includes('TAMPOCO'));
  });
  test('si no hay div.blog-content, devuelve el html tal cual', () => {
    const html = '<html><body><main>simple</main></body></html>';
    assert.equal(extractWordpressBlogContent(html), html);
  });
});

describe('processPage', () => {
  test('produce title + text + length sin widgets ni footer', async () => {
    const html = await loadFixture('microsite-home.html');
    const page = processPage({ url: 'https://fce.unl.edu.ar/mba/', html });
    // Con extractSectionTitle, prioriza el h1 del cropped content sobre el <title> doc
    assert.equal(page.title, 'Maestría en Administración de Empresas');
    assert.ok(page.text.includes('posgrado profesional'));
    assert.ok(!page.text.includes('NO DEBE APARECER'));
    assert.ok(!page.text.includes('TAMPOCO'));
    assert.ok(page.length > 0);
  });
});

describe('formatRawText + hashContent', () => {
  test('genera el formato esperado con headers', () => {
    const raw = formatRawText({ pages: [
      { url: 'https://x/1', title: 'Uno', text: 'a', length: 1 },
      { url: 'https://x/2', title: 'Dos', text: 'b', length: 1 },
    ]});
    assert.match(raw, /--- INICIO: Uno :: https:\/\/x\/1 ---/);
    assert.match(raw, /--- FIN: https:\/\/x\/1 ---/);
    assert.match(raw, /--- INICIO: Dos :: https:\/\/x\/2 ---/);
  });
  test('hash es determinístico', () => {
    const a = hashContent('hola');
    const b = hashContent('hola');
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, hashContent('hola '));
  });
  test('marca errores en pages', () => {
    const raw = formatRawText({ pages: [
      { url: 'https://x/err', error: 'HTTP 500', text: '', length: 0 },
    ]});
    assert.match(raw, /--- ERROR: https:\/\/x\/err :: HTTP 500 ---/);
  });
});

describe('scrapeBySource', () => {
  test('fce-microsite scrapea home + subpáginas descubiertas', async () => {
    const home = await loadFixture('microsite-home.html');
    const sub = await loadFixture('microsite-subpage.html');
    const fetchImpl = buildMockFetch({
      'https://fce.unl.edu.ar/mba/index.php?act=': sub,
      'https://fce.unl.edu.ar/mba/': home,
    });
    const r = await scrapeBySource(
      { slug: 'mba', url: 'https://fce.unl.edu.ar/mba/', strategy: 'fce-microsite' },
      { fetchImpl },
    );
    assert.equal(r.strategy, 'fce-microsite');
    assert.equal(r.pages.length, 5); // 1 home + 4 subpáginas del fixture
    assert.match(r.pages[0].title, /Maestría en Administración/);
  });

  test('wordpress-homepage scrapea solo home', async () => {
    const html = '<html><head><title>FHUC</title></head><body><main>contenido</main></body></html>';
    const fetchImpl = buildMockFetch({ 'https://fhuc.unl.edu.ar/': html });
    const r = await scrapeBySource(
      { slug: 'x', url: 'https://fhuc.unl.edu.ar/', strategy: 'wordpress-homepage' },
      { fetchImpl },
    );
    assert.equal(r.strategy, 'wordpress-homepage');
    assert.equal(r.pages.length, 1);
  });

  test('TBD se skipea con flag', async () => {
    const r = await scrapeBySource(
      { slug: 'x', url: 'https://example.com/', strategy: 'TBD' },
      { fetchImpl: async () => { throw new Error('no debería llamarse'); } },
    );
    assert.equal(r.skipped, true);
  });

  test('fce-wordpress extrae solo blog-content y descarta sidebar/footer', async () => {
    const html = await loadFixture('wordpress-page.html');
    const fetchImpl = buildMockFetch({ 'https://www.fce.unl.edu.ar/academica/categorias/regimen/': html });
    const r = await scrapeBySource(
      { slug: 'regimen-de-ensenanza', url: 'https://www.fce.unl.edu.ar/academica/categorias/regimen/', strategy: 'fce-wordpress' },
      { fetchImpl },
    );
    assert.equal(r.strategy, 'fce-wordpress');
    assert.equal(r.pages.length, 1);
    assert.match(r.pages[0].title, /Normas y Procedimientos/);
    assert.ok(r.pages[0].text.includes('Inscripción a materias'));
    assert.ok(!r.pages[0].text.includes('NO DEBE APARECER'));
    assert.ok(!r.pages[0].text.includes('TAMPOCO'));
  });

  test('strategy desconocida tira', async () => {
    await assert.rejects(
      () => scrapeBySource({ slug: 'x', url: 'https://x/', strategy: 'unknown' }),
      /Unknown strategy/,
    );
  });
});

describe('runForSource', () => {
  test('persiste meta + raw en stateDir y detecta unchanged en segunda corrida', async () => {
    const home = await loadFixture('microsite-home.html');
    const sub = await loadFixture('microsite-subpage.html');
    const fetchImpl = buildMockFetch({
      'https://fce.unl.edu.ar/mba/index.php?act=': sub,
      'https://fce.unl.edu.ar/mba/': home,
    });
    const stateDir = await mkdtemp(join(tmpdir(), 'scraper-test-'));
    try {
      const source = { slug: 'mba', url: 'https://fce.unl.edu.ar/mba/', strategy: 'fce-microsite' };
      const first = await runForSource(source, { stateDir, fetchImpl });
      assert.equal(first.status, 'new');
      assert.ok(first.hash);
      // Segundo run, mismo contenido → unchanged
      const second = await runForSource(source, { stateDir, fetchImpl });
      assert.equal(second.status, 'unchanged');
      assert.equal(second.hash, first.hash);

      // Meta presente
      const meta = JSON.parse(await readFile(join(stateDir, 'mba.meta.json'), 'utf8'));
      assert.equal(meta.slug, 'mba');
      assert.equal(meta.content_hash, first.hash);
      assert.ok(meta.pages_count >= 1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('detecta change cuando el contenido cambia', async () => {
    const v1 = '<html><head><title>v1</title></head><body><main>contenido viejo</main></body></html>';
    const v2 = '<html><head><title>v2</title></head><body><main>contenido nuevo</main></body></html>';

    const stateDir = await mkdtemp(join(tmpdir(), 'scraper-test-'));
    try {
      const source = { slug: 'x', url: 'https://example.com/', strategy: 'wordpress-homepage' };
      const r1 = await runForSource(source, { stateDir, fetchImpl: buildMockFetch({ 'https://example.com/': v1 }) });
      assert.equal(r1.status, 'new');
      const r2 = await runForSource(source, { stateDir, fetchImpl: buildMockFetch({ 'https://example.com/': v2 }) });
      assert.equal(r2.status, 'changed');
      assert.notEqual(r2.hash, r1.hash);
      assert.equal(r2.previous_hash, r1.hash);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('strategy TBD devuelve status=skipped sin tocar fs', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'scraper-test-'));
    try {
      const source = { slug: 'x', url: 'https://example.com/', strategy: 'TBD' };
      const r = await runForSource(source, { stateDir, fetchImpl: async () => { throw new Error('no'); } });
      assert.equal(r.status, 'skipped');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
