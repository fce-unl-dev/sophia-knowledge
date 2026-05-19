// Scraper determinístico de cursos de formación profesional.
//
// Objetivo B.3:
//   - Leer el listado oficial de cursos activos.
//   - Detectar altas/bajas/cambios contra indice.json.
//   - Generar candidatos Markdown por curso sin crear un documento agregado.
//   - NO modifica el KB publicado ni indice.json; solo produce reportes/candidatos.
//
// Uso CLI:
//   node scrape_courses.mjs
//   node scrape_courses.mjs --write-candidates
//   node scrape_courses.mjs --url=https://... --out=state/cursos-de-formacion
//
// Outputs:
//   state/cursos-de-formacion/cursos-de-formacion.meta.json      metadata diff-first
//   state/cursos-de-formacion/cursos-de-formacion.catalog.json   catálogo normalizado de cursos activos
//   state/cursos-de-formacion/candidates/{slug}.candidate.md     candidatos opcionales (--write-candidates)

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchHtml, htmlToText, decodeEntities } from './scrape.mjs';

const DEFAULT_COURSES_URL = 'https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showCursos';
const DEFAULT_CONTACT_EMAIL = 'cursosdeformacion@fce.unl.edu.ar';
const DEFAULT_LISTING_PUBLIC_URL = 'https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showCursos';
const COURSE_SECTION_NAMES = [
  'Fundamentación',
  'Destinatarios',
  'Requisitos',
  'Contenidos',
  'Objetivos',
  'Datos clave del cursado',
  'Perfil de egreso',
  'Modalidad de cursado',
  'Evaluación',
  'Certificación',
  'Docentes',
  'Costo',
];

// ---------- Normalización ----------

export function normalizeSpaces(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeTitle(value = '') {
  return normalizeSpaces(value)
    .toLocaleLowerCase('es-AR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugifyTitle(value = '') {
  return normalizeTitle(value)
    .replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function absolutizeUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href.replace(/&amp;/g, '&'), baseUrl).toString();
  } catch {
    return null;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compactForHash(course) {
  return {
    title: course.title,
    slug: course.slug,
    start_date: course.start_date,
    detail_url: course.detail_url,
    signup_url: course.signup_url,
    query_url: course.query_url,
    detail_text_hash: course.detail_text_hash,
  };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Listado de cursos ----------

export function parseCourseList(html, baseUrl = DEFAULT_COURSES_URL) {
  const courses = [];
  const seen = new Set();
  // No dependemos del texto visible del link porque puede venir como entidades HTML
  // (Más información / M&aacute;s informaci&oacute;n). Filtramos por presencia de Inicio.
  const detailRe = /<a\b[^>]*href\s*=\s*["']([^"']*index\.php\?act=showSubcategoria[^"']*)["'][^>]*>/gi;
  let match;

  while ((match = detailRe.exec(html)) !== null) {
    const detailUrl = absolutizeUrl(match[1], baseUrl);
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    const beforeWindow = html.slice(Math.max(0, match.index - 1800), match.index);
    const beforeText = htmlToText(beforeWindow);
    const lines = beforeText.split('\n').map((line) => normalizeSpaces(line)).filter(Boolean);
    const inicioIndex = findLastIndex(lines, (line) => /^Inicio\s*:/i.test(line));
    if (inicioIndex < 0) continue;

    const title = inferCourseTitle(lines, inicioIndex);
    const startDate = parseStartDate(lines[inicioIndex]);

    const afterWindow = html.slice(match.index + match[0].length, match.index + match[0].length + 1400);
    const queryUrl = firstHref(afterWindow, baseUrl, /act=showConsulta/i);
    const signupUrl = firstHref(afterWindow, baseUrl, /act=showLogin/i);
    const courseId = signupUrl ? new URL(signupUrl).searchParams.get('id_curso') : null;
    const detailId = detailUrl ? new URL(detailUrl).searchParams.get('id') : null;

    if (!title) continue;
    courses.push({
      title,
      normalized_title: normalizeTitle(title),
      slug: slugifyTitle(title),
      start_date: startDate,
      detail_id: detailId,
      course_id: courseId,
      detail_url: detailUrl,
      query_url: queryUrl,
      signup_url: signupUrl,
    });
  }

  return courses;
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

function inferCourseTitle(lines, inicioIndex) {
  const stopWords = new Set([
    'consultas',
    'pre-inscripción',
    'pre-inscripcion',
    'más información',
    'mas información',
    'mas informacion',
    'image',
  ]);
  const end = inicioIndex >= 0 ? inicioIndex : lines.length;
  for (let i = end - 1; i >= 0; i--) {
    const candidate = normalizeSpaces(lines[i]);
    if (!candidate) continue;
    const key = normalizeTitle(candidate);
    if (stopWords.has(key)) continue;
    if (/^Inicio\s*:/i.test(candidate)) continue;
    if (/^Inscripciones abiertas/i.test(candidate)) continue;
    if (/^Se encuentran abiertas/i.test(candidate)) continue;
    if (candidate.length < 4) continue;
    return candidate;
  }
  return '';
}

function parseStartDate(line) {
  const match = /Inicio\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(line || '');
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function firstHref(html, baseUrl, hrefPredicate) {
  const hrefRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    const href = decodeEntities(match[1]).replace(/&amp;/g, '&');
    if (hrefPredicate.test(href)) return absolutizeUrl(href, baseUrl);
  }
  return null;
}

// ---------- Página de detalle ----------

export async function hydrateCourseDetails(courses, { fetchImpl = fetch } = {}) {
  const hydrated = [];
  for (const course of courses) {
    try {
      const res = await fetchHtml(course.detail_url, { fetchImpl });
      const detail = parseCourseDetail(res.html, res.url || course.detail_url);
      hydrated.push({ ...course, ...detail, detail_url: res.url || course.detail_url });
    } catch (err) {
      hydrated.push({
        ...course,
        detail_error: String(err.message || err),
        detail_text: '',
        detail_text_hash: null,
        sections: {},
      });
    }
  }
  return hydrated;
}

export function parseCourseDetail(html, detailUrl) {
  const text = normalizeSpaces(htmlToText(html));
  const mainText = cutDetailNoise(text);
  const sections = splitCourseSections(mainText);
  return {
    detail_url: detailUrl,
    detail_text: mainText,
    detail_text_hash: sha256(mainText),
    sections,
  };
}

function cutDetailNoise(text) {
  const startMarkers = ['Fundamentación', 'Destinatarios', 'Requisitos', 'Contenidos'];
  let start = 0;
  for (const marker of startMarkers) {
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      start = idx;
      break;
    }
  }
  let body = text.slice(start);
  const endMarkers = [
    '\nCONSULTAS\n',
    '\nEntorno Virtual\n',
    '\nCursos de Formación\n',
    '\nCopyright ©',
  ];
  let end = body.length;
  for (const marker of endMarkers) {
    const idx = body.indexOf(marker);
    if (idx >= 0 && idx < end) end = idx;
  }
  return normalizeSpaces(body.slice(0, end));
}

export function splitCourseSections(text) {
  const sectionSet = new Set(COURSE_SECTION_NAMES.map(normalizeTitle));
  const sections = {};
  let current = 'Información adicional';
  let buffer = [];

  function flush() {
    const value = normalizeSpaces(buffer.join('\n'));
    if (value) sections[current] = value;
    buffer = [];
  }

  for (const rawLine of text.split('\n')) {
    const line = normalizeSpaces(rawLine);
    if (!line) continue;
    if (sectionSet.has(normalizeTitle(line))) {
      flush();
      current = COURSE_SECTION_NAMES.find((name) => normalizeTitle(name) === normalizeTitle(line)) || line;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

// ---------- Comparación contra indice.json ----------

export async function loadIndexedCourses(kbRoot) {
  const indexPath = join(kbRoot, 'indice.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  return (index.items || [])
    .filter((item) => item.path?.startsWith('cursos/') && item.path.endsWith('.md'))
    .map((item) => ({
      ...item,
      normalized_title: normalizeTitle(item.title || ''),
      slug: item.path.replace(/^cursos\//, '').replace(/\.md$/, ''),
    }));
}

export function compareCoursesWithIndex(activeCourses, indexedCourses) {
  const byNormalizedTitle = new Map(indexedCourses.map((item) => [item.normalized_title, item]));
  const bySlug = new Map(indexedCourses.map((item) => [item.slug, item]));
  const matchedIndexPaths = new Set();

  const active = activeCourses.map((course) => {
    const match = byNormalizedTitle.get(course.normalized_title) || bySlug.get(course.slug) || null;
    if (match) matchedIndexPaths.add(match.path);
    return {
      ...course,
      index_status: match ? 'indexed' : 'new_unindexed',
      index_path: match?.path || `cursos/${course.slug}.md`,
      index_title: match?.title || null,
    };
  });

  const missing_from_active_source = indexedCourses
    .filter((item) => !matchedIndexPaths.has(item.path))
    .map((item) => ({
      path: item.path,
      title: item.title,
      slug: item.slug,
      status: 'indexed_but_not_active_in_source',
    }));

  return {
    active,
    matched_count: active.filter((course) => course.index_status === 'indexed').length,
    new_unindexed: active.filter((course) => course.index_status === 'new_unindexed'),
    missing_from_active_source,
  };
}

// ---------- Markdown candidato ----------

export function buildCourseMarkdown(course, { today = todayIsoDate(), listingUrl = DEFAULT_LISTING_PUBLIC_URL } = {}) {
  const s = course.sections || {};
  const lines = [];
  const title = toTitleCaseCourse(course.title);

  lines.push(`# ${title}`);
  lines.push('');
  lines.push('## Identificación');
  lines.push('');
  lines.push(`- **Nombre oficial**: ${course.title}`);
  lines.push('- **Tipo**: Curso de formación profesional');
  lines.push('- **Unidad académica**: FCE-UNL');
  lines.push('- **Acreditación CONEAU**: no aplica');
  if (course.detail_id) lines.push(`- **ID página detalle**: ${course.detail_id}`);
  if (course.course_id) lines.push(`- **ID inscripción**: ${course.course_id}`);

  lines.push('');
  lines.push('## Modalidad y duración');
  lines.push('');
  appendBlock(lines, s['Datos clave del cursado'] || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');
  if (course.start_date) lines.push(`- **Fecha de inicio publicada en listado**: ${course.start_date}`);

  lines.push('');
  lines.push('## Plan de estudios / Contenidos');
  lines.push('');
  appendBlock(lines, s.Contenidos || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');

  lines.push('');
  lines.push('## Objetivos');
  lines.push('');
  appendBlock(lines, s.Objetivos || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');

  lines.push('');
  lines.push('## Destinatarios');
  lines.push('');
  appendBlock(lines, s.Destinatarios || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');

  lines.push('');
  lines.push('## Cuerpo docente');
  lines.push('');
  appendBlock(lines, s.Docentes || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');

  lines.push('');
  lines.push('## Requisitos de admisión');
  lines.push('');
  appendBlock(lines, s.Requisitos || 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');

  lines.push('');
  lines.push('## Metodología y evaluación');
  lines.push('');
  appendNamedBlock(lines, 'Modalidad de cursado', s['Modalidad de cursado']);
  appendNamedBlock(lines, 'Evaluación', s.Evaluación);
  appendNamedBlock(lines, 'Certificación', s.Certificación);
  if (!s['Modalidad de cursado'] && !s.Evaluación && !s.Certificación) {
    appendBlock(lines, 'No publicado en fuentes oficiales — consultar con cursosdeformacion@fce.unl.edu.ar.');
  }

  lines.push('');
  lines.push('## Aranceles e inscripción');
  lines.push('');
  appendNamedBlock(lines, 'Costo', s.Costo || `Consultar a ${DEFAULT_CONTACT_EMAIL}.`);
  lines.push(`- **Estado (al ${today})**: Inscripción abierta según listado oficial.`);
  if (course.signup_url) lines.push(`- **Sistema de inscripción**: ${course.signup_url}`);
  if (course.query_url) lines.push(`- **Formulario de consultas**: ${course.query_url}`);

  lines.push('');
  lines.push('## Contacto');
  lines.push('');
  lines.push(`- **Email**: ${DEFAULT_CONTACT_EMAIL}`);
  lines.push('- **Teléfono FCE**: +54 (0342) 4571179 / 4571181');
  lines.push('- **Dirección**: Moreno 2557, S3000CVE, Santa Fe');

  lines.push('');
  lines.push('## Información adicional relevante');
  lines.push('');
  appendNamedBlock(lines, 'Fundamentación', s.Fundamentación);
  appendNamedBlock(lines, 'Perfil de egreso', s['Perfil de egreso']);
  if (!s.Fundamentación && !s['Perfil de egreso']) {
    appendBlock(lines, 'No publicado en fuentes oficiales.');
  }

  lines.push('');
  lines.push('## Fuentes consultadas');
  lines.push('');
  lines.push(`- Listado oficial de inscripciones abiertas: ${listingUrl}`);
  lines.push(`- Página oficial del curso: ${course.detail_url}`);
  if (course.signup_url) lines.push(`- Sistema de inscripción: ${course.signup_url}`);

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Última revisión automática**: ${today} (candidato generado por scraper determinístico de cursos)`);
  lines.push('**Revisión humana**: pendiente');
  lines.push('');
  return lines.join('\n');
}

function appendBlock(lines, block) {
  const text = normalizeSpaces(block);
  if (!text) return;
  const blockLines = text.split('\n').map((line) => normalizeSpaces(line)).filter(Boolean);
  for (const line of blockLines) {
    if (/^[-*]\s+/.test(line)) lines.push(line);
    else lines.push(`- ${line}`);
  }
}

function appendNamedBlock(lines, name, block) {
  const text = normalizeSpaces(block);
  if (!text) return;
  lines.push(`- **${name}**:`);
  for (const line of text.split('\n').map((value) => normalizeSpaces(value)).filter(Boolean)) {
    lines.push(`  - ${line.replace(/^[-*]\s+/, '')}`);
  }
}

function toTitleCaseCourse(title) {
  return normalizeSpaces(title)
    .toLocaleLowerCase('es-AR')
    .replace(/(^|[\s:—-])([a-záéíóúñü])/g, (_, prefix, char) => `${prefix}${char.toLocaleUpperCase('es-AR')}`)
    .replace(/\bIa\b/g, 'IA')
    .replace(/\bUnl\b/g, 'UNL')
    .replace(/\bFce\b/g, 'FCE');
}

// ---------- Orquestador ----------

export async function runCoursesScraper({
  url = DEFAULT_COURSES_URL,
  stateDir,
  kbRoot,
  write = true,
  writeCandidates = false,
  fetchImpl = fetch,
  today = todayIsoDate(),
} = {}) {
  const listRes = await fetchHtml(url, { fetchImpl });
  const listedCourses = parseCourseList(listRes.html, listRes.url || url);
  const hydratedCourses = await hydrateCourseDetails(listedCourses, { fetchImpl });
  const indexedCourses = await loadIndexedCourses(kbRoot);
  const comparison = compareCoursesWithIndex(hydratedCourses, indexedCourses);

  const catalog = {
    source_url: listRes.url || url,
    generated_at: new Date().toISOString(),
    active_count: comparison.active.length,
    matched_count: comparison.matched_count,
    new_unindexed_count: comparison.new_unindexed.length,
    missing_from_active_source_count: comparison.missing_from_active_source.length,
    active: comparison.active,
    new_unindexed: comparison.new_unindexed.map(toCatalogSummary),
    missing_from_active_source: comparison.missing_from_active_source,
  };

  const stableHashPayload = JSON.stringify(comparison.active.map(compactForHash), null, 2);
  const contentHash = sha256(stableHashPayload);
  const metaPath = join(stateDir, 'cursos-de-formacion.meta.json');
  const catalogPath = join(stateDir, 'cursos-de-formacion.catalog.json');
  let previousHash = null;
  if (existsSync(metaPath)) {
    try {
      const previous = JSON.parse(await readFile(metaPath, 'utf8'));
      previousHash = previous.content_hash || null;
    } catch { /* meta corrupto; se sobrescribe */ }
  }

  const status = previousHash && previousHash === contentHash ? 'unchanged' : (previousHash ? 'changed' : 'new');
  const meta = {
    slug: 'cursos-de-formacion',
    strategy: 'fce-courses-list',
    source_url: listRes.url || url,
    content_hash: contentHash,
    previous_hash: previousHash,
    status,
    active_count: catalog.active_count,
    matched_count: catalog.matched_count,
    new_unindexed_count: catalog.new_unindexed_count,
    missing_from_active_source_count: catalog.missing_from_active_source_count,
    scraped_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  };

  const candidateFiles = [];
  if (write) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

    if (writeCandidates) {
      const candidatesDir = join(stateDir, 'candidates');
      await mkdir(candidatesDir, { recursive: true });
      for (const course of comparison.active) {
        const md = buildCourseMarkdown(course, { today, listingUrl: listRes.url || url });
        const candidatePath = join(candidatesDir, `${course.slug}.candidate.md`);
        await writeFile(candidatePath, md, 'utf8');
        candidateFiles.push(candidatePath);
      }
    }
  }

  return {
    ok: true,
    decision: status === 'unchanged' ? 'no_change' : 'candidate_ready',
    status,
    meta_path: metaPath,
    catalog_path: catalogPath,
    candidate_files: candidateFiles,
    ...meta,
    new_unindexed: catalog.new_unindexed,
    missing_from_active_source: catalog.missing_from_active_source,
  };
}

function toCatalogSummary(course) {
  return {
    title: course.title,
    slug: course.slug,
    start_date: course.start_date,
    detail_url: course.detail_url,
    signup_url: course.signup_url,
    proposed_index_path: course.index_path,
  };
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: DEFAULT_COURSES_URL },
      out: { type: 'string', default: 'state/cursos-de-formacion' },
      'kb-root': { type: 'string', default: '../..' },
      'write-candidates': { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia deterministic courses scraper\n\nUso:\n  node scrape_courses.mjs [--write-candidates]\n\nOpciones:\n  --url=<url>              URL del listado oficial\n  --out=<dir>              Directorio de salida dentro de tools/scraper\n  --kb-root=<dir>          Raíz del repo para leer indice.json\n  --write-candidates       Escribe candidates/*.candidate.md\n  --no-write               Solo imprime report JSON\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);

  const report = await runCoursesScraper({
    url: values.url,
    stateDir,
    kbRoot,
    write: !values['no-write'],
    writeCandidates: values['write-candidates'],
  });

  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
