// Scraper determinístico de CURSOS DE POSGRADO de la FCE-UNL.
//
// Fuente: el catálogo público /academica/categorias/propuesta/cursos-de-posgrado-propuesta/
// embebe un iframe con el listado real, el mismo sistema microsite que los cursos
// de formación:  https://www.fce.unl.edu.ar/cursos_posgrado/index.php?act=showCursos
//
// Cada curso es un <div class='curso'> con:
//   - título en <b>…</b>            (a veces con el año al final, ej. "… 2026")
//   - "Inicio:<b> DD/MM/AAAA</b>"   (fecha de inicio publicada)
//   - "Más información" → ../media/cursos-posgrado/{ID}.pdf   (ficha/resolución oficial)
//   - "PRE-INSCRIPCIÓN" → ../posgrados/index.php?act=showLogin&id_posgrado={ID}
//
// Genera 1 MD por curso en /cursos-posgrado/ a partir de los datos del listado +
// el texto del PDF oficial. NO usa IA para redactar (determinístico y testeable);
// el texto del PDF se incorpora con un saneo de datos personales (DNIs, etc.).
//
// Uso CLI:
//   node scrape_courses_posgrado.mjs --kb-root=../.. --write-candidates
//   node scrape_courses_posgrado.mjs --kb-root=../.. --offline=/tmp/listado.html  (test)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const LISTING_URL = 'https://www.fce.unl.edu.ar/cursos_posgrado/index.php?act=showCursos';
const CATALOG_PUBLIC_URL = 'https://www.fce.unl.edu.ar/academica/categorias/propuesta/cursos-de-posgrado-propuesta/';
const MEDIA_BASE = 'https://www.fce.unl.edu.ar/media/cursos-posgrado/';
const KB_FOLDER = 'cursos-posgrado';
const CONTACT_EMAIL = 'posgrado@fce.unl.edu.ar';
const FETCH_TIMEOUT_MS = 20000;

// ---------- utilidades ----------

export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function todayIsoDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function decodeEntities(s) {
  return s
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&aelig;/g, 'æ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Título de display: quita un año al final (ej. "… 2026") para el slug y el nombre canónico.
function stripTrailingYear(title) {
  return title.replace(/\s+20\d{2}\s*$/, '').trim();
}

export function slugify(title) {
  return stripTrailingYear(title)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// DD/MM/AAAA → AAAA-MM-DD (o null si no parsea).
function toIsoDate(ddmmaaaa) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((ddmmaaaa || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Saneo de datos personales: borra DNIs/documentos que aparezcan junto a personas.
// Conserva datos institucionales (emails de área, resoluciones, teléfonos FCE).
export function scrubPII(text) {
  if (!text) return text;
  return text
    // "DNI N° 23.701.072", "D.N.I. Nº 34299166", "DNI: 22.215.589"
    .replace(/\bD\.?\s*N\.?\s*I\.?\s*(?:N[°º]?|:)?\s*\d[\d.\s]{5,}\d/gi, 'DNI [omitido]')
    // "(D.N.I. N° 38.898.177)" sin la sigla pegada por OCR
    .replace(/\(\s*D\.?N\.?I\.?[^)]*\)/gi, '(DNI [omitido])');
}

// ---------- fetch ----------

async function fetchText(url, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SophiaKB/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPdfText(url, { fetchImpl = fetch, pdfParseImpl = null, logImpl = console } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let buf;
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SophiaKB/1.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    let pdf = pdfParseImpl;
    if (!pdf) ({ default: pdf } = await import('pdf-parse'));
    const data = await pdf(buf);
    return (data.text || '').trim();
  } catch (err) {
    logImpl.warn?.(`[posgrado] no pude leer PDF ${url}: ${err.message}`);
    return '';
  }
}

// ---------- parseo del listado ----------

export function parseListing(html, { listingUrl = LISTING_URL } = {}) {
  const courses = [];
  const re = /<div class='curso'>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    const titleM = /<b>([\s\S]*?)<\/b>/.exec(block);
    if (!titleM) continue;
    const rawTitle = decodeEntities(titleM[1].replace(/\s+/g, ' ')).trim().replace(/\.\s*$/, '');
    const startM = /Inicio:\s*<b>\s*([0-9/]+)\s*<\/b>/.exec(block);
    const pdfM = /href='[^']*media\/cursos-posgrado\/(\d+)\.pdf'/i.exec(block);
    const preM = /id_posgrado=(\d+)/.exec(block);
    const id = pdfM?.[1] || preM?.[1] || null;
    if (!id) continue;
    courses.push({
      id,
      title: stripTrailingYear(rawTitle),
      raw_title: rawTitle,
      slug: slugify(rawTitle),
      start_date_raw: startM?.[1] || null,
      start_date_iso: toIsoDate(startM?.[1]),
      pdf_url: pdfM ? `${MEDIA_BASE}${id}.pdf` : null,
      preinscripcion_url: preM ? `https://www.fce.unl.edu.ar/posgrados/index.php?act=showLogin&id_posgrado=${preM[1]}` : null,
    });
  }
  return courses;
}

// ---------- construcción del MD ----------

export function buildCourseMarkdown(course, pdfText, { today = todayIsoDate() } = {}) {
  const L = [];
  const startHuman = course.start_date_raw || 'A confirmar';
  L.push(`# ${course.title}`);
  L.push('');
  L.push(`Curso de posgrado de la Facultad de Ciencias Económicas (FCE-UNL). Información extraída del catálogo oficial de cursos de posgrado y de la ficha publicada por la facultad.`);
  L.push('');
  L.push('## Identificación');
  L.push('');
  L.push(`- **Nombre oficial**: ${course.title}`);
  L.push('- **Tipo**: Curso de posgrado');
  L.push('- **Unidad académica**: FCE-UNL');
  L.push('- **Acreditación CONEAU**: no aplica');
  L.push(`- **ID de inscripción**: ${course.id}`);
  L.push('');
  L.push('## Modalidad y duración');
  L.push('');
  L.push(`- **Fecha de inicio publicada**: ${startHuman}`);
  L.push('- **Modalidad y carga horaria**: ver detalle del programa más abajo (según la ficha oficial).');
  L.push('');
  L.push('## Programa (según ficha oficial)');
  L.push('');
  if (pdfText && pdfText.trim()) {
    L.push('> El siguiente contenido fue extraído del documento oficial del curso. Para el detalle formal, consultá la ficha publicada y la Secretaría de Posgrado.');
    L.push('');
    L.push(scrubPII(pdfText).trim());
  } else {
    L.push('Detalle del programa no disponible en el documento al momento de la extracción. Consultá la ficha oficial o escribí a ' + CONTACT_EMAIL + '.');
  }
  L.push('');
  L.push('## Aranceles e inscripción');
  L.push('');
  L.push('- **Aranceles**: A consultar con la Secretaría de Posgrado FCE-UNL.');
  L.push(`- **Estado de inscripción (al ${today})**: Curso publicado en el catálogo oficial de cursos de posgrado. Confirmá la apertura de inscripción con la Secretaría de Posgrado.`);
  if (course.preinscripcion_url) L.push(`- **Pre-inscripción**: ${course.preinscripcion_url}`);
  L.push('- **Sistema de inscripción**: Preinscripción en línea en el sistema de Posgrado (https://www.fce.unl.edu.ar/posgrados).');
  L.push('');
  L.push('## Contacto');
  L.push('');
  L.push(`- **Email de Secretaría de Posgrado FCE-UNL**: ${CONTACT_EMAIL}`);
  L.push('- **WhatsApp Posgrado**: +54 9 342 449 1939');
  L.push('- **Teléfono FCE general**: +54 (0342) 4571179 / 4571181');
  L.push('');
  L.push('## Fuentes consultadas');
  L.push('');
  L.push(`- Catálogo oficial de cursos de posgrado: ${CATALOG_PUBLIC_URL}`);
  if (course.pdf_url) L.push(`- Ficha oficial del curso: ${course.pdf_url}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(`**Última revisión automática**: ${today} (candidato generado por el scraper determinístico de cursos de posgrado)`);
  L.push('**Revisión humana**: pendiente');
  L.push('');
  return L.join('\n');
}

// ---------- runner ----------

export async function runPosgradoCoursesScraper({
  kbRoot,
  stateDir,
  today = todayIsoDate(),
  writeCandidates = false,
  offlineHtml = null,
  offlinePdfDir = null,
  fetchImpl = fetch,
} = {}) {
  const html = offlineHtml
    ? await readFile(offlineHtml, 'utf8')
    : await fetchText(LISTING_URL, { fetchImpl });

  const courses = parseListing(html);

  for (const course of courses) {
    let pdfText = '';
    if (offlinePdfDir) {
      const p = join(offlinePdfDir, `${course.id}.pdf`);
      if (existsSync(p)) {
        let pdf;
        ({ default: pdf } = await import('pdf-parse'));
        pdfText = ((await pdf(await readFile(p))).text || '').trim();
      }
    } else if (course.pdf_url) {
      pdfText = await fetchPdfText(course.pdf_url, { fetchImpl });
    }
    course.markdown = buildCourseMarkdown(course, pdfText, { today });
    course.content_hash = sha256(course.markdown.replace(/\*\*Última revisión automática\*\*.*$/m, ''));
    course.kb_path = `${KB_FOLDER}/${course.slug}.md`;
  }

  const stableHash = sha256(courses.map(c => `${c.id}:${c.content_hash}`).sort().join('|'));

  if (writeCandidates && stateDir) {
    const candDir = join(stateDir, 'candidates');
    await mkdir(candDir, { recursive: true });
    for (const c of courses) {
      await writeFile(join(candDir, `${c.slug}.candidate.md`), c.markdown, 'utf8');
    }
    const meta = {
      generated_at: today,
      listing_url: LISTING_URL,
      stable_hash: stableHash,
      courses: courses.map(({ id, title, slug, start_date_iso, kb_path, content_hash }) =>
        ({ id, title, slug, start_date_iso, kb_path, content_hash })),
    };
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'cursos-posgrado.meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }

  return { courses, active_count: courses.length, stable_hash: stableHash, listing_url: LISTING_URL };
}

// ---------- CLI ----------

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '../..' },
      'state-dir': { type: 'string', default: 'state/cursos-posgrado' },
      'write-candidates': { type: 'boolean', default: false },
      'offline': { type: 'string' },
      'offline-pdf-dir': { type: 'string' },
      'json': { type: 'boolean', default: false },
    },
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = resolve(here, values['kb-root']);
  const stateDir = resolve(here, values['state-dir']);
  const report = await runPosgradoCoursesScraper({
    kbRoot,
    stateDir,
    writeCandidates: values['write-candidates'],
    offlineHtml: values.offline ? resolve(values.offline) : null,
    offlinePdfDir: values['offline-pdf-dir'] ? resolve(values['offline-pdf-dir']) : null,
  });
  if (values.json) {
    console.log(JSON.stringify({
      active_count: report.active_count,
      stable_hash: report.stable_hash,
      courses: report.courses.map(({ id, title, slug, start_date_iso, kb_path }) => ({ id, title, slug, start_date_iso, kb_path })),
    }, null, 2));
  } else {
    console.log(`Cursos de posgrado detectados: ${report.active_count}`);
    for (const c of report.courses) {
      console.log(`  - [${c.id}] ${c.title}  (inicio ${c.start_date_iso || 'A confirmar'}) → ${c.kb_path}`);
    }
  }
}
