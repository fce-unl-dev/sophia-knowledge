// Extractor determinístico para páginas simples de /estudiantes/.
//
// Objetivo C.2:
//   - Leer fuentes candidatas registradas en sources.json con slug estudiantes-*.
//   - Generar candidatos Markdown solo para páginas simples y de bajo riesgo.
//   - Detectar, pero NO publicar, fuentes con Sheets/iframes/datos nominales/dinámicas.
//   - NO modifica /estudiantes/ publicado ni indice.json; solo produce state + candidates.
//
// Uso:
//   node scrape_students.mjs
//   node scrape_students.mjs --write-candidates
//   node scrape_students.mjs --slug=estudiantes-examenes --write-candidates
//   node scrape_students.mjs --no-write

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  fetchHtml,
  htmlToText,
  decodeEntities,
  extractSectionTitle,
  extractTitle,
  extractWordpressBlogContent,
} from './scrape.mjs';

const DEFAULT_STATE_DIR = 'state/estudiantes';
const DEFAULT_SOURCES_PATH = 'sources.json';

const SIMPLE_STUDENT_SLUGS = new Set([
  'estudiantes-home',
  'estudiantes-examenes',
  'estudiantes-tramites',
  'estudiantes-consultas',
  'estudiantes-pai',
  'estudiantes-centro-estudiantes',
]);

const DEFERRED_STUDENT_SOURCES = {
  'estudiantes-examenes-finales': 'contiene enlaces a planillas de turnos; requiere snapshot tabular antes de publicar fechas',
  'estudiantes-examenes-parciales': 'contiene iframe/datos embebidos; requiere resolver fuente real y snapshot',
  'estudiantes-inscripciones-cursado': 'puede contener listados nominales de estudiantes; requiere filtro de privacidad',
  'estudiantes-parciales-notas-muestras': 'página dinámica; requiere evaluar si los datos están en HTML público o sistema externo',
};

const SYSTEM_HOSTS = new Set([
  'servicios.unl.edu.ar',
  'servicios.unl.edu.ar:443',
  'www.siu.edu.ar',
]);

export async function runStudentsScraper({
  sourcesPath,
  stateDir,
  slug = null,
  write = true,
  writeCandidates = false,
  fetchImpl = fetch,
  today = todayIsoDate(),
} = {}) {
  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));
  let sources = (sourcesData.sources || []).filter((source) => source.slug?.startsWith('estudiantes-'));
  if (slug) sources = sources.filter((source) => source.slug === slug);
  if (slug && sources.length === 0) {
    return {
      ok: false,
      decision: 'error',
      error: `No existe fuente estudiantes con slug ${slug}`,
      processed: [],
    };
  }

  const processed = [];
  const candidates = [];
  const deferred = [];
  const warnings = [];

  for (const source of sources) {
    if (!SIMPLE_STUDENT_SLUGS.has(source.slug)) {
      const reason = DEFERRED_STUDENT_SOURCES[source.slug] || 'fuente no marcada como página simple en C.2';
      deferred.push({ slug: source.slug, url: source.url, indice_path: source.indice_path, reason });
      continue;
    }

    try {
      const page = await scrapeStudentPage(source, { fetchImpl, today });
      processed.push(page.summary);

      if (page.summary.requires_review) {
        warnings.push(`${source.slug}: requiere revisión (${page.summary.review_reasons.join(', ')})`);
      }

      const candidateMarkdown = buildStudentMarkdown(page, { today });
      candidates.push({
        slug: source.slug,
        path: source.indice_path,
        candidate_file: `${source.slug}.candidate.md`,
        requires_review: page.summary.requires_review,
        review_reasons: page.summary.review_reasons,
      });

      if (write && writeCandidates) {
        const candidatesDir = join(stateDir, 'candidates');
        await mkdir(candidatesDir, { recursive: true });
        await writeFile(join(candidatesDir, `${source.slug}.candidate.md`), candidateMarkdown, 'utf8');
      }
    } catch (err) {
      warnings.push(`${source.slug}: error ${err.message || err}`);
      processed.push({
        slug: source.slug,
        url: source.url,
        status: 'error',
        error: String(err.message || err),
      });
    }
  }

  const stablePayload = JSON.stringify({ processed, deferred, candidates }, null, 2);
  const contentHash = sha256(stablePayload);
  const metaPath = join(stateDir, 'estudiantes.meta.json');
  const catalogPath = join(stateDir, 'estudiantes.catalog.json');
  let previousHash = null;
  if (existsSync(metaPath)) {
    try {
      const previous = JSON.parse(await readFile(metaPath, 'utf8'));
      previousHash = previous.content_hash || null;
    } catch { /* meta corrupto; se sobrescribe */ }
  }

  const status = previousHash && previousHash === contentHash ? 'unchanged' : (previousHash ? 'changed' : 'new');
  const report = {
    ok: true,
    decision: status === 'unchanged' ? 'no_change' : 'candidate_ready',
    status,
    content_hash: contentHash,
    previous_hash: previousHash,
    generated_at: new Date().toISOString(),
    simple_sources_count: processed.length,
    candidates_count: candidates.length,
    deferred_count: deferred.length,
    warnings_count: warnings.length,
    processed,
    candidates,
    deferred,
    warnings,
  };

  if (write) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({
      slug: 'estudiantes',
      strategy: 'fce-students-simple-pages',
      content_hash: contentHash,
      previous_hash: previousHash,
      status,
      simple_sources_count: processed.length,
      deferred_count: deferred.length,
      warnings_count: warnings.length,
      scraped_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    await writeFile(catalogPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  return { ...report, meta_path: metaPath, catalog_path: catalogPath };
}

export async function scrapeStudentPage(source, { fetchImpl = fetch, today = todayIsoDate() } = {}) {
  const res = await fetchHtml(source.url, { fetchImpl });
  const contentHtml = extractWordpressBlogContent(res.html);
  const title = extractSectionTitle(contentHtml) || sourceTitleFromSlug(source.slug) || extractTitle(res.html);
  const bodyText = normalizeStudentText(htmlToText(contentHtml));
  const links = extractLinks(contentHtml, res.url || source.url);
  const signals = detectRiskSignals({ html: contentHtml, text: bodyText, links });
  const reviewReasons = [];

  if (signals.has_iframe) reviewReasons.push('iframe detectado');
  if (signals.google_sheet_links.length) reviewReasons.push('links a Google Sheets detectados');
  if (signals.possible_personal_data) reviewReasons.push('posibles datos personales/listados nominales');
  if (signals.system_links.length) reviewReasons.push('links a sistemas externos');
  if (bodyText.length < 80) reviewReasons.push('contenido textual muy corto');

  return {
    source,
    title,
    url: res.url || source.url,
    bodyText,
    links,
    signals,
    today,
    summary: {
      slug: source.slug,
      url: res.url || source.url,
      indice_path: source.indice_path,
      title,
      status: 'candidate_ready',
      text_length: bodyText.length,
      links_count: links.length,
      pdf_links_count: links.filter((link) => link.kind === 'pdf').length,
      google_sheet_links_count: signals.google_sheet_links.length,
      system_links_count: signals.system_links.length,
      has_iframe: signals.has_iframe,
      possible_personal_data: signals.possible_personal_data,
      requires_review: reviewReasons.length > 0,
      review_reasons: reviewReasons,
    },
  };
}

export function buildStudentMarkdown(page, { today = todayIsoDate() } = {}) {
  const lines = [];
  const source = page.source;
  const publicTitle = page.title || sourceTitleFromSlug(source.slug) || source.slug;

  lines.push(`# ${publicTitle}`);
  lines.push('');
  lines.push('## Para qué sirve');
  lines.push('');
  lines.push(`- Esta página resume información publicada por FCE-UNL para estudiantes en la fuente oficial ${page.url}.`);
  lines.push('- Es un candidato generado automáticamente y debe pasar por revisión humana antes de publicarse en `indice.json`.');
  lines.push('');

  lines.push('## Información publicada');
  lines.push('');
  appendTextAsBullets(lines, page.bodyText);
  lines.push('');

  const pdfLinks = page.links.filter((link) => link.kind === 'pdf');
  const systemLinks = page.signals.system_links;
  const googleSheets = page.signals.google_sheet_links;
  const otherLinks = page.links.filter((link) => link.kind === 'external' || link.kind === 'internal').slice(0, 20);

  lines.push('## Sistemas relacionados y enlaces');
  lines.push('');
  if (!pdfLinks.length && !systemLinks.length && !googleSheets.length && !otherLinks.length) {
    lines.push('- No se detectaron enlaces relevantes en el contenido principal.');
  }
  appendLinkGroup(lines, 'PDFs / formularios', pdfLinks);
  appendLinkGroup(lines, 'Google Sheets detectados', googleSheets);
  appendLinkGroup(lines, 'Sistemas externos', systemLinks);
  appendLinkGroup(lines, 'Otros enlaces', otherLinks);
  lines.push('');

  lines.push('## Advertencias para Sophia');
  lines.push('');
  if (page.summary.requires_review) {
    for (const reason of page.summary.review_reasons) {
      lines.push(`- Requiere revisión humana: ${reason}.`);
    }
  } else {
    lines.push('- No se detectaron señales automáticas de iframe, Google Sheets ni datos nominales, pero la revisión humana sigue siendo obligatoria.');
  }
  lines.push('- No responder con datos personalizados o detrás de login; derivar al sistema oficial correspondiente.');
  lines.push('- Si la fuente enlaza una planilla o iframe con fechas, responder solo si existe snapshot Markdown revisado.');
  lines.push('');

  lines.push('## Fuentes consultadas');
  lines.push('');
  lines.push(`- Página oficial FCE-UNL: ${page.url}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Última revisión automática**: ${today} (candidato generado por scraper determinístico de estudiantes)`);
  lines.push('**Revisión humana**: pendiente');
  lines.push('');
  return lines.join('\n');
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = decodeEntities(match[1]).replace(/&amp;/g, '&').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    let url;
    try { url = new URL(href, baseUrl); } catch { continue; }
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const text = normalizeSpaces(htmlToText(match[2]) || normalized);
    links.push({ text, url: normalized, kind: classifyLink(url) });
  }
  return links;
}

function classifyLink(url) {
  const href = url.toString().toLowerCase();
  if (url.hostname === 'docs.google.com' && href.includes('/spreadsheets/')) return 'google_sheet';
  if (href.endsWith('.pdf') || href.includes('.pdf?')) return 'pdf';
  if (SYSTEM_HOSTS.has(url.host) || href.includes('/sica') || href.includes('/cup') || href.includes('guarani')) return 'system';
  if (url.hostname.endsWith('fce.unl.edu.ar') || url.hostname.endsWith('unl.edu.ar')) return 'internal';
  return 'external';
}

function detectRiskSignals({ html, text, links }) {
  const googleSheetLinks = links.filter((link) => link.kind === 'google_sheet');
  const systemLinks = links.filter((link) => link.kind === 'system');
  const hasIframe = /<iframe\b/i.test(html);
  const possiblePersonalData = detectPossiblePersonalData(text);
  return {
    has_iframe: hasIframe,
    google_sheet_links: googleSheetLinks,
    system_links: systemLinks,
    possible_personal_data: possiblePersonalData,
  };
}

function detectPossiblePersonalData(text) {
  const normalized = normalizeSpaces(text).toLocaleLowerCase('es-AR');
  if (/nombre\s+y\s+apellido/.test(normalized)) return true;
  if (/dni|documento/.test(normalized) && /(listado|lista|alumnos|estudiantes)/.test(normalized)) return true;
  const likelyNameRows = normalized.split('\n').filter((line) => {
    const words = line.trim().split(/\s+/);
    return words.length >= 2 && /^[a-záéíóúñ]+\s+[a-záéíóúñ]+/.test(line.trim()) && /\|/.test(line);
  });
  return likelyNameRows.length >= 3;
}

function normalizeStudentText(text) {
  return normalizeSpaces(text)
    .split('\n')
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .filter((line) => !/^image$/i.test(line))
    .filter((line) => !/^iframe$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendTextAsBullets(lines, text) {
  const paragraphs = normalizeStudentText(text).split('\n').filter(Boolean);
  if (!paragraphs.length) {
    lines.push('- No se pudo extraer texto suficiente de la fuente.');
    return;
  }
  for (const paragraph of paragraphs) {
    if (/^[-*]\s+/.test(paragraph)) lines.push(paragraph);
    else lines.push(`- ${paragraph}`);
  }
}

function appendLinkGroup(lines, title, links) {
  if (!links.length) return;
  lines.push(`- **${title}**:`);
  for (const link of links) {
    lines.push(`  - ${link.text}: ${link.url}`);
  }
}

function normalizeSpaces(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sourceTitleFromSlug(slug) {
  const map = {
    'estudiantes-home': 'Estudiantes FCE-UNL',
    'estudiantes-examenes': 'Exámenes',
    'estudiantes-tramites': 'Trámites para estudiantes',
    'estudiantes-consultas': 'Clases de consultas',
    'estudiantes-pai': 'Prácticas Académicas Internas',
    'estudiantes-centro-estudiantes': 'Centro de Estudiantes',
  };
  return map[slug] || slug;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: DEFAULT_SOURCES_PATH },
      out: { type: 'string', default: DEFAULT_STATE_DIR },
      slug: { type: 'string' },
      'write-candidates': { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia students deterministic scraper\n\nUso:\n  node scrape_students.mjs [--write-candidates]\n  node scrape_students.mjs --slug=estudiantes-examenes --write-candidates\n\nOpciones:\n  --source=<path>       sources.json\n  --out=<dir>           directorio de salida\n  --slug=<slug>         procesa solo una fuente estudiantes-*\n  --write-candidates    escribe candidates/*.candidate.md\n  --no-write            solo imprime report JSON\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = values.source.startsWith('/') ? values.source : resolve(here, values.source);
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const report = await runStudentsScraper({
    sourcesPath,
    stateDir,
    slug: values.slug || null,
    write: !values['no-write'],
    writeCandidates: values['write-candidates'],
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
