// Extractor determinístico para /estudiantes/ organizado por temas del menú.
//
// Objetivo C.2 corregido:
//   - Respetar la estructura de la web de Estudiantes: 1 MD por título/tema.
//   - Cada MD agrupa la página principal del tema y subpáginas relacionadas.
//   - Excluir páginas obsoletas o sin contenido útil (ej. Ingreso 2025).
//   - Detectar Sheets/iframes/sistemas externos/datos personales, pero no publicar.
//   - NO modifica /estudiantes/ publicado ni indice.json; solo produce state + candidates.
//
// Uso:
//   node scrape_students.mjs
//   node scrape_students.mjs --write-candidates
//   node scrape_students.mjs --slug=estudiantes-examenes --write-candidates
//   node scrape_students.mjs --no-write

import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

export const STUDENT_TOPICS = [
  {
    slug: 'estudiantes-ingreso-2026',
    title: 'Ingreso 2026',
    path: 'estudiantes/ingreso-2026.md',
    pages: [
      ['Ingreso 2026', 'https://www.fce.unl.edu.ar/estudiantes/ingreso-2026/'],
    ],
  },
  {
    slug: 'estudiantes-tramites-internos',
    title: 'Trámites internos',
    path: 'estudiantes/tramites-internos.md',
    pages: [
      ['Trámites internos', 'https://www.fce.unl.edu.ar/estudiantes/tramites-internos/'],
      ['Ingresantes', 'https://www.fce.unl.edu.ar/estudiantes/categorias/tramites/ingresantes/'],
      ['Estudiantes', 'https://www.fce.unl.edu.ar/estudiantes/categorias/tramites/estudiantes/'],
      ['Graduados', 'https://www.fce.unl.edu.ar/estudiantes/categorias/tramites/graduados/'],
    ],
  },
  {
    slug: 'estudiantes-calendario-academico',
    title: 'Calendario Académico',
    path: 'estudiantes/calendario-academico.md',
    pages: [
      ['Calendario Académico', 'https://www.fce.unl.edu.ar/estudiantes/categorias/calendario/'],
    ],
  },
  {
    slug: 'estudiantes-bienestar-estudiantil',
    title: 'Bienestar Estudiantil',
    path: 'estudiantes/bienestar-estudiantil.md',
    pages: [
      ['Bienestar Estudiantil', 'https://www.fce.unl.edu.ar/estudiantes/categorias/bienestar/'],
      ['BAPI', 'https://www.fce.unl.edu.ar/estudiantes/categorias/bienestar/bapi/'],
      ['Becas ofrecidas por UNL', 'https://www.fce.unl.edu.ar/estudiantes/categorias/bienestar/becas-ofrecidas-por-unl/'],
      ['Movilidad estudiantil', 'https://www.fce.unl.edu.ar/estudiantes/categorias/bienestar/movilidad-estudiantil/'],
      ['Prácticas Académicas Internas', 'https://www.fce.unl.edu.ar/estudiantes/pai/'],
    ],
  },
  {
    slug: 'estudiantes-pasantias-rentadas',
    title: 'Pasantías rentadas',
    path: 'estudiantes/pasantias-rentadas.md',
    pages: [
      ['Pasantías rentadas', 'https://www.fce.unl.edu.ar/estudiantes/pasantias-rentadas/'],
    ],
  },
  {
    slug: 'estudiantes-practicas-profesionales-supervisadas',
    title: 'Prácticas Profesionales Supervisadas',
    path: 'estudiantes/practicas-profesionales-supervisadas.md',
    pages: [
      ['Prácticas Profesionales Supervisadas', 'https://www.fce.unl.edu.ar/estudiantes/pps/'],
    ],
  },
  {
    slug: 'estudiantes-inscripciones-cursado',
    title: 'Info sobre inscripciones a cursado',
    path: 'estudiantes/inscripciones-cursado.md',
    pages: [
      ['Info sobre inscripciones a cursado', 'https://www.fce.unl.edu.ar/estudiantes/info-sobre-inscripciones/'],
    ],
  },
  {
    slug: 'estudiantes-siu-guarani',
    title: 'SIU Guaraní',
    path: 'estudiantes/siu-guarani.md',
    pages: [
      ['SIU Guaraní', 'https://www.fce.unl.edu.ar/estudiantes/siu-guarani/'],
    ],
  },
  {
    slug: 'estudiantes-sica',
    title: 'Sistema Informático de Consultas de Alumnos (SICA)',
    path: 'estudiantes/sica.md',
    pages: [
      ['Sistema Informático de Consultas de Alumnos (SICA)', 'https://www.fce.unl.edu.ar/estudiantes/sica/'],
    ],
  },
  {
    slug: 'estudiantes-examenes',
    title: 'Exámenes',
    path: 'estudiantes/examenes.md',
    pages: [
      ['Exámenes', 'https://www.fce.unl.edu.ar/estudiantes/examenes/'],
      ['Exámenes finales', 'https://www.fce.unl.edu.ar/estudiantes/examenes-finales/'],
      ['Exámenes parciales', 'https://www.fce.unl.edu.ar/estudiantes/examenes-parciales/'],
    ],
  },
  {
    slug: 'estudiantes-clases-consultas',
    title: 'Clases de Consultas',
    path: 'estudiantes/clases-consultas.md',
    pages: [
      ['Clases de Consultas', 'https://www.fce.unl.edu.ar/estudiantes/categorias/consultas/'],
      ['Consultas para exámenes', 'https://www.fce.unl.edu.ar/estudiantes/categorias/consultas/consultas-para-examenes/'],
      ['Consultas permanentes', 'https://www.fce.unl.edu.ar/estudiantes/categorias/consultas/consultas-permanentes/'],
      ['Parciales: entrega de notas y muestra de exámenes', 'https://www.fce.unl.edu.ar/estudiantes/parciales-entrega-de-notas-y-muestra-de-examenes/'],
      ['Finales: entrega de notas y muestra de exámenes', 'https://www.fce.unl.edu.ar/estudiantes/finales-entrega-de-notas-y-muestra-de-examenes/'],
      ['Avisos de asignaturas', 'https://www.fce.unl.edu.ar/estudiantes/avisos-de-asignaturas/'],
    ],
  },
  {
    slug: 'estudiantes-centro-estudiantes',
    title: 'Centro de Estudiantes',
    path: 'estudiantes/centro-estudiantes.md',
    pages: [
      ['Centro de Estudiantes', 'https://www.fce.unl.edu.ar/estudiantes/centro-de-estudiantes/'],
    ],
  },
  {
    slug: 'estudiantes-horarios-atencion',
    title: 'Horarios de Atención',
    path: 'estudiantes/horarios-atencion.md',
    pages: [
      ['Horarios de Atención', 'https://www.fce.unl.edu.ar/estudiantes/horarios-de-atencion/'],
    ],
  },
  {
    slug: 'estudiantes-beneficios-posgrados',
    title: 'Beneficios para Posgrados FCE UNL',
    path: 'estudiantes/beneficios-posgrados-fce-unl.md',
    pages: [
      ['Beneficios para Posgrados FCE UNL', 'https://www.fce.unl.edu.ar/estudiantes/beneficios-para-posgrados-fce-unl/'],
    ],
  },
];

export const EXCLUDED_STUDENT_TOPICS = [
  {
    title: 'Ingreso 2025',
    url: 'https://www.fce.unl.edu.ar/estudiantes/ingreso-2025/',
    reason: 'obsoleto: fue reemplazado por Ingreso 2026 y no debe incorporarse como fuente vigente',
  },
];

const SYSTEM_HOSTS = new Set(['servicios.unl.edu.ar', 'www.siu.edu.ar']);

export async function runStudentsScraper({
  stateDir,
  slug = null,
  write = true,
  writeCandidates = false,
  fetchImpl = fetch,
  today = todayIsoDate(),
} = {}) {
  let topics = STUDENT_TOPICS;
  if (slug) topics = topics.filter((topic) => topic.slug === slug);
  if (slug && topics.length === 0) {
    return { ok: false, decision: 'error', error: `No existe tema de estudiantes con slug ${slug}` };
  }

  const processed = [];
  const candidates = [];
  const warnings = [];

  for (const topic of topics) {
    const result = await scrapeStudentTopic(topic, { fetchImpl, today });
    processed.push(result.summary);
    if (result.summary.pages_with_content === 0) {
      warnings.push(`${topic.slug}: sin páginas con contenido útil; no se genera candidato`);
      continue;
    }
    if (result.summary.requires_review) {
      warnings.push(`${topic.slug}: requiere revisión (${result.summary.review_reasons.join(', ')})`);
    }

    const markdown = buildTopicMarkdown(result, { today });
    candidates.push({
      slug: topic.slug,
      path: topic.path,
      candidate_file: `${topic.slug}.candidate.md`,
      pages_count: result.pages.length,
      pages_with_content: result.summary.pages_with_content,
      requires_review: result.summary.requires_review,
      review_reasons: result.summary.review_reasons,
    });

    if (write && writeCandidates) {
      const candidatesDir = join(stateDir, 'candidates');
      await mkdir(candidatesDir, { recursive: true });
      await writeFile(join(candidatesDir, `${topic.slug}.candidate.md`), markdown, 'utf8');
    }
  }

  const stablePayload = JSON.stringify({ processed, candidates, excluded: EXCLUDED_STUDENT_TOPICS }, null, 2);
  const contentHash = sha256(stablePayload);
  const metaPath = join(stateDir, 'estudiantes.meta.json');
  const catalogPath = join(stateDir, 'estudiantes.catalog.json');
  let previousHash = null;
  if (existsSync(metaPath)) {
    try {
      previousHash = JSON.parse(await readFile(metaPath, 'utf8')).content_hash || null;
    } catch { /* ignore corrupt meta */ }
  }
  const status = previousHash && previousHash === contentHash ? 'unchanged' : (previousHash ? 'changed' : 'new');
  const report = {
    ok: true,
    decision: status === 'unchanged' ? 'no_change' : 'candidate_ready',
    status,
    content_hash: contentHash,
    previous_hash: previousHash,
    generated_at: new Date().toISOString(),
    topics_count: processed.length,
    candidates_count: candidates.length,
    excluded_count: EXCLUDED_STUDENT_TOPICS.length,
    warnings_count: warnings.length,
    processed,
    candidates,
    excluded: EXCLUDED_STUDENT_TOPICS,
    warnings,
  };

  if (write) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({
      slug: 'estudiantes',
      strategy: 'fce-students-menu-topics',
      content_hash: contentHash,
      previous_hash: previousHash,
      status,
      topics_count: processed.length,
      candidates_count: candidates.length,
      excluded_count: EXCLUDED_STUDENT_TOPICS.length,
      warnings_count: warnings.length,
      scraped_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    await writeFile(catalogPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  return { ...report, meta_path: metaPath, catalog_path: catalogPath };
}

export async function scrapeStudentTopic(topic, { fetchImpl = fetch } = {}) {
  const pages = [];
  for (const [label, url] of topic.pages) {
    try {
      const page = await scrapeStudentPage({ label, url }, { fetchImpl });
      pages.push(page);
    } catch (err) {
      pages.push({ label, url, error: String(err.message || err), text: '', links: [], signals: emptySignals() });
    }
  }

  const allLinks = pages.flatMap((page) => page.links || []);
  const signals = mergeSignals(pages.map((page) => page.signals || emptySignals()));
  const reviewReasons = [];
  if (signals.has_iframe) reviewReasons.push('iframe detectado');
  if (signals.google_sheet_links.length) reviewReasons.push('links a Google Sheets detectados');
  if (signals.possible_personal_data) reviewReasons.push('posibles datos personales/listados nominales');
  if (signals.system_links.length) reviewReasons.push('links a sistemas externos');
  if (pages.some((page) => page.error)) reviewReasons.push('una o más subpáginas no pudieron descargarse');

  const pagesWithContent = pages.filter((page) => normalizeSpaces(page.text).length >= 80).length;
  return {
    topic,
    pages,
    links: allLinks,
    signals,
    summary: {
      slug: topic.slug,
      title: topic.title,
      indice_path: topic.path,
      pages_count: topic.pages.length,
      pages_with_content: pagesWithContent,
      links_count: allLinks.length,
      pdf_links_count: allLinks.filter((link) => link.kind === 'pdf').length,
      google_sheet_links_count: signals.google_sheet_links.length,
      system_links_count: signals.system_links.length,
      has_iframe: signals.has_iframe,
      possible_personal_data: signals.possible_personal_data,
      requires_review: reviewReasons.length > 0,
      review_reasons: reviewReasons,
    },
  };
}

export async function scrapeStudentPage({ label, url }, { fetchImpl = fetch } = {}) {
  const res = await fetchHtml(url, { fetchImpl });
  const contentHtml = extractWordpressBlogContent(res.html);
  const title = extractSectionTitle(contentHtml) || label || extractTitle(res.html);
  const text = normalizeStudentText(htmlToText(contentHtml));
  const links = extractLinks(contentHtml, res.url || url);
  const signals = detectRiskSignals({ html: contentHtml, text, links });
  return { label, title, url: res.url || url, text, links, signals, error: null };
}

export function buildTopicMarkdown(result, { today = todayIsoDate() } = {}) {
  const { topic, pages, signals, summary } = result;
  const lines = [];
  lines.push(`# ${topic.title}`);
  lines.push('');
  lines.push('## Para qué sirve');
  lines.push('');
  lines.push(`- Este documento agrupa la información vigente del tema **${topic.title}** publicada en la sección Estudiantes de FCE-UNL.`);
  lines.push('- Incluye la página principal del tema y sus subpáginas relacionadas cuando existen.');
  lines.push('- Es un candidato automático: debe pasar por revisión humana antes de agregarse a `indice.json`.');
  lines.push('');

  lines.push('## Información publicada');
  lines.push('');
  for (const page of pages) {
    lines.push(`### ${page.title || page.label}`);
    lines.push('');
    if (page.error) {
      lines.push(`- No se pudo descargar esta subpágina durante la revisión automática: ${page.error}`);
    } else if (normalizeSpaces(page.text).length < 80) {
      lines.push('- No se detectó contenido textual suficiente en esta subpágina. Revisar manualmente si corresponde excluirla.');
    } else {
      appendTextAsBullets(lines, page.text);
    }
    lines.push('');
  }

  lines.push('## Enlaces y sistemas relacionados');
  lines.push('');
  const pdfLinks = result.links.filter((link) => link.kind === 'pdf');
  const sheetLinks = signals.google_sheet_links;
  const systemLinks = signals.system_links;
  const otherLinks = result.links.filter((link) => ['internal', 'external'].includes(link.kind)).slice(0, 30);
  if (!pdfLinks.length && !sheetLinks.length && !systemLinks.length && !otherLinks.length) {
    lines.push('- No se detectaron enlaces relevantes en el contenido principal.');
  }
  appendLinkGroup(lines, 'PDFs / formularios', pdfLinks);
  appendLinkGroup(lines, 'Google Sheets detectados', sheetLinks);
  appendLinkGroup(lines, 'Sistemas externos', systemLinks);
  appendLinkGroup(lines, 'Otros enlaces', otherLinks);
  lines.push('');

  lines.push('## Advertencias para Sophia');
  lines.push('');
  if (summary.requires_review) {
    for (const reason of summary.review_reasons) lines.push(`- Requiere revisión humana: ${reason}.`);
  } else {
    lines.push('- No se detectaron señales automáticas de iframe, Google Sheets, sistemas externos ni datos nominales; la revisión humana sigue siendo obligatoria.');
  }
  lines.push('- No responder con datos personalizados o detrás de login; derivar al sistema oficial correspondiente.');
  lines.push('- Si una subpágina enlaza una planilla o iframe con fechas, responder sobre esos datos solo si existe snapshot Markdown revisado.');
  lines.push('');

  lines.push('## Fuentes consultadas');
  lines.push('');
  for (const [label, url] of topic.pages) lines.push(`- ${label}: ${url}`);
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
  if (SYSTEM_HOSTS.has(url.hostname) || href.includes('/sica') || href.includes('/cup') || href.includes('guarani')) return 'system';
  if (url.hostname.endsWith('fce.unl.edu.ar') || url.hostname.endsWith('unl.edu.ar')) return 'internal';
  return 'external';
}

function detectRiskSignals({ html, text, links }) {
  return {
    has_iframe: /<iframe\b/i.test(html),
    google_sheet_links: links.filter((link) => link.kind === 'google_sheet'),
    system_links: links.filter((link) => link.kind === 'system'),
    possible_personal_data: detectPossiblePersonalData(text),
  };
}

function mergeSignals(items) {
  return {
    has_iframe: items.some((item) => item.has_iframe),
    google_sheet_links: dedupeLinks(items.flatMap((item) => item.google_sheet_links || [])),
    system_links: dedupeLinks(items.flatMap((item) => item.system_links || [])),
    possible_personal_data: items.some((item) => item.possible_personal_data),
  };
}

function emptySignals() {
  return { has_iframe: false, google_sheet_links: [], system_links: [], possible_personal_data: false };
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function detectPossiblePersonalData(text) {
  const normalized = normalizeSpaces(text).toLocaleLowerCase('es-AR');
  if (/nombre\s+y\s+apellido/.test(normalized)) return true;
  if (/dni|documento/.test(normalized) && /(listado|lista|alumnos|estudiantes)/.test(normalized)) return true;
  return false;
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
  for (const link of links) lines.push(`  - ${link.text}: ${link.url}`);
}

function normalizeSpaces(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      out: { type: 'string', default: DEFAULT_STATE_DIR },
      slug: { type: 'string' },
      'write-candidates': { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia students topic scraper\n\nUso:\n  node scrape_students.mjs [--write-candidates]\n  node scrape_students.mjs --slug=estudiantes-examenes --write-candidates\n\nOpciones:\n  --out=<dir>           directorio de salida\n  --slug=<slug>         procesa solo un tema del menú estudiantes\n  --write-candidates    escribe candidates/*.candidate.md\n  --no-write            solo imprime report JSON\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const report = await runStudentsScraper({
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
