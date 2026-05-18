// Scraper del KB de Sophia. Dos estrategias: 'fce-microsite' descubre el menú
// lateral de microsites FCE y baja todas las subpáginas; 'wordpress-homepage'
// solo baja la home (suficiente como ficha base + derivación al sitio oficial).
//
// Uso CLI:
//   node scrape.mjs --slug=mba [--out=state/] [--source=sources.json] [--no-write]
//   node scrape.mjs --all [--out=state/]
//
// Output por slug:
//   state/{slug}.raw.txt   contenido scrapeado plano con headers por página
//   state/{slug}.meta.json metadata: hash, urls, timestamps, status
//
// Diff-first: si el hash del nuevo scrape == hash anterior en meta.json, devuelve
// status='unchanged' y skipea escrituras de raw.txt (meta.json sí se actualiza
// con last_checked_at).

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USER_AGENT = 'sophia-kb-scraper/0.1 (+https://github.com/fce-unl-dev/sophia-knowledge)';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const CONCURRENCY = 4;

// ---------- HTTP ----------

export async function fetchHtml(url, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, retries = MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      const html = await res.text();
      return { url: res.url || url, status: res.status, html };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(RETRY_DELAY_MS * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- HTML utilities ----------

// Decode HTML entities sin parser externo. Cubre los comunes que aparecen en
// los microsites FCE (acentos, ñ, comillas tipográficas, dashes, NBSP).
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  iquest: '¿', iexcl: '¡', deg: '°', ordm: 'º', ordf: 'ª',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', euro: '€',
};

export function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

// Strip tags conservando texto, normalizando whitespace.
export function htmlToText(html) {
  let s = html;
  // Eliminar script, style, noscript completos
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  // Convertir <br>, </p>, </li>, </h*> a newlines
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|article|section)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  // Stripear el resto
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Normalizar whitespace: colapsar spaces, conservar saltos
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  // Eliminar líneas que son sólo bullets vacíos (residuo de menús con íconos)
  s = s.split('\n').filter((line) => line.trim() !== '-' && line.trim() !== '').join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// Title específico de la sección: preferimos el primer h1/h2 del cropped content
// porque en microsites FCE todas las subpáginas comparten el mismo <title>.
export function extractSectionTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = decodeEntities(h1[1].replace(/<[^>]+>/g, '')).trim();
    if (t) return t;
  }
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) {
    const t = decodeEntities(h2[1].replace(/<[^>]+>/g, '')).trim();
    if (t) return t;
  }
  return '';
}

// Corta widgets/footer típicos del template FCE.
const CUT_MARKERS = [
  /<footer\b/i,
  /<div[^>]+id=["']footer["']/i,
  /<div[^>]+class=["'][^"']*\bfooter\b/i,
  /<div[^>]+id=["']widgets["']/i,
  /<aside\b/i,
];

export function cropMainContent(html) {
  let cutIndex = html.length;
  for (const re of CUT_MARKERS) {
    const m = html.match(re);
    if (m && m.index !== undefined && m.index < cutIndex) cutIndex = m.index;
  }
  return html.slice(0, cutIndex);
}

// ---------- Discovery ----------

// Encuentra subpáginas del menú lateral del template FCE. Los hrefs vienen
// como 'index.php?act=showSubcategoria&id=N' (a veces showCategoria/showNoticia).
// Devuelve array de URLs absolutas únicas, en orden de aparición.
export function discoverFceMicrositeLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']*index\.php\?act=show(?:Subcategoria|Categoria|Noticia)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    href = href.replace(/&amp;/g, '&');
    const abs = absolutizeUrl(href, baseUrl);
    if (!abs) continue;
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---------- Page processing ----------

export function processPage({ url, html }) {
  const docTitle = extractTitle(html);
  const cropped = cropMainContent(html);
  const sectionTitle = extractSectionTitle(cropped);
  const title = sectionTitle || docTitle;
  const text = htmlToText(cropped);
  return { url, title, text, length: text.length };
}

// ---------- Strategies ----------

export async function scrapeFceMicrosite(rootUrl, { fetchImpl = fetch, concurrency = CONCURRENCY } = {}) {
  const homeRes = await fetchHtml(rootUrl, { fetchImpl });
  const homePage = processPage({ url: homeRes.url, html: homeRes.html });
  const subpaths = discoverFceMicrositeLinks(homeRes.html, homeRes.url);

  const subPages = await mapWithConcurrency(subpaths, concurrency, async (subUrl) => {
    try {
      const res = await fetchHtml(subUrl, { fetchImpl });
      return processPage({ url: res.url, html: res.html });
    } catch (err) {
      return { url: subUrl, title: '', text: '', length: 0, error: String(err.message || err) };
    }
  });

  return { strategy: 'fce-microsite', pages: [homePage, ...subPages] };
}

export async function scrapeWordpressHomepage(rootUrl, { fetchImpl = fetch } = {}) {
  const res = await fetchHtml(rootUrl, { fetchImpl });
  const page = processPage({ url: res.url, html: res.html });
  return { strategy: 'wordpress-homepage', pages: [page] };
}

export async function scrapeBySource(source, { fetchImpl = fetch } = {}) {
  if (source.strategy === 'fce-microsite') return scrapeFceMicrosite(source.url, { fetchImpl });
  if (source.strategy === 'wordpress-homepage') return scrapeWordpressHomepage(source.url, { fetchImpl });
  if (source.strategy === 'TBD') {
    return { strategy: 'TBD', pages: [], skipped: true, reason: 'strategy not implemented yet' };
  }
  throw new Error(`Unknown strategy: ${source.strategy}`);
}

// ---------- Output formatting ----------

export function formatRawText({ pages }) {
  const parts = [];
  for (const p of pages) {
    if (p.error) {
      parts.push(`--- ERROR: ${p.url} :: ${p.error} ---\n`);
      continue;
    }
    parts.push(`--- INICIO: ${p.title || '(sin título)'} :: ${p.url} ---`);
    parts.push(p.text);
    parts.push(`--- FIN: ${p.url} ---\n`);
  }
  return parts.join('\n\n');
}

export function hashContent(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- Concurrency helper ----------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Diff-first runner ----------

export async function runForSource(source, { stateDir, fetchImpl = fetch, write = true } = {}) {
  const result = await scrapeBySource(source, { fetchImpl });

  if (result.skipped) {
    return { slug: source.slug, status: 'skipped', reason: result.reason, hash: null };
  }

  const rawText = formatRawText(result);
  const hash = hashContent(rawText);
  const now = new Date().toISOString();

  const metaPath = join(stateDir, `${source.slug}.meta.json`);
  const rawPath = join(stateDir, `${source.slug}.raw.txt`);

  let previousHash = null;
  if (existsSync(metaPath)) {
    try {
      const prev = JSON.parse(await readFile(metaPath, 'utf8'));
      previousHash = prev.content_hash || null;
    } catch { /* meta corrupto, lo sobrescribimos */ }
  }

  const meta = {
    slug: source.slug,
    url: source.url,
    strategy: source.strategy,
    content_hash: hash,
    previous_hash: previousHash,
    pages_count: result.pages.length,
    pages: result.pages.map((p) => ({ url: p.url, title: p.title, length: p.length, error: p.error })),
    scraped_at: now,
    last_checked_at: now,
  };

  const status = previousHash && previousHash === hash ? 'unchanged' : (previousHash ? 'changed' : 'new');

  if (write) {
    await mkdir(stateDir, { recursive: true });
    if (status !== 'unchanged') {
      await writeFile(rawPath, rawText, 'utf8');
    }
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }

  return { slug: source.slug, status, hash, previous_hash: previousHash, pages_count: result.pages.length, meta_path: metaPath, raw_path: rawPath };
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      all: { type: 'boolean', default: false },
      source: { type: 'string', default: 'sources.json' },
      out: { type: 'string', default: 'state' },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || (!values.slug && !values.all)) {
    console.log(`Sophia KB scraper

Uso:
  node scrape.mjs --slug=<slug> [--out=state/] [--source=sources.json] [--no-write]
  node scrape.mjs --all       [--out=state/] [--source=sources.json] [--no-write]

Slugs disponibles: leer sources.json.
`);
    process.exit(values.help ? 0 : 1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = values.source.startsWith('/') ? values.source : join(here, values.source);
  const stateDir = values.out.startsWith('/') ? values.out : join(here, values.out);

  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const sources = sourcesData.sources || [];
  const targets = values.all ? sources : sources.filter((s) => s.slug === values.slug);

  if (targets.length === 0) {
    console.error(`No matching source for slug='${values.slug}'`);
    process.exit(2);
  }

  const write = !values['no-write'];
  const report = [];
  for (const src of targets) {
    process.stderr.write(`→ ${src.slug} (${src.strategy})\n`);
    try {
      const r = await runForSource(src, { stateDir, write });
      report.push(r);
      process.stderr.write(`  ${r.status}  pages=${r.pages_count ?? 0}  hash=${(r.hash || '').slice(0, 12)}\n`);
    } catch (err) {
      const r = { slug: src.slug, status: 'error', error: String(err.message || err) };
      report.push(r);
      process.stderr.write(`  ERROR: ${r.error}\n`);
    }
  }

  console.log(JSON.stringify({ ok: true, count: report.length, results: report }, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
