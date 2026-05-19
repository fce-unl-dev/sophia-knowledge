// Validador de catálogo generado por scrape_courses.mjs.
//
// Puede validar un archivo catalog.json existente o ejecutar el scraper en modo
// no-write para validar la fuente viva. Por defecto no usa red.
//
// Uso:
//   node validate_course_catalog.mjs --catalog=state/cursos-de-formacion/cursos-de-formacion.catalog.json
//   node validate_course_catalog.mjs --run-scraper

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runCoursesScraper } from './scrape_courses.mjs';

const MIN_EXPECTED_ACTIVE_COURSES = 1;

export async function validateCourseCatalog({ catalogPath, runScraper = false, kbRoot, stateDir } = {}) {
  const errors = [];
  const warnings = [];
  let catalog;
  let source = '';

  if (runScraper) {
    const report = await runCoursesScraper({ kbRoot, stateDir, write: false });
    catalog = {
      active_count: report.active_count,
      matched_count: report.matched_count,
      new_unindexed_count: report.new_unindexed_count,
      missing_from_active_source_count: report.missing_from_active_source_count,
      active: [],
      new_unindexed: report.new_unindexed || [],
      missing_from_active_source: report.missing_from_active_source || [],
    };
    source = 'live scraper';
  } else {
    if (!catalogPath || !existsSync(catalogPath)) {
      return {
        ok: false,
        errors: [`No existe catálogo para validar: ${catalogPath || '(sin --catalog)'}`],
        warnings,
        summary: {},
      };
    }
    source = catalogPath;
    try {
      catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [`Catálogo no parsea como JSON: ${err.message}`], warnings, summary: {} };
    }
  }

  if (!Number.isInteger(catalog.active_count) || catalog.active_count < MIN_EXPECTED_ACTIVE_COURSES) {
    errors.push(`active_count inválido o demasiado bajo: ${catalog.active_count}`);
  }
  if (!Number.isInteger(catalog.matched_count) || catalog.matched_count < 0) {
    errors.push(`matched_count inválido: ${catalog.matched_count}`);
  }
  if (!Number.isInteger(catalog.new_unindexed_count) || catalog.new_unindexed_count < 0) {
    errors.push(`new_unindexed_count inválido: ${catalog.new_unindexed_count}`);
  }
  if (!Number.isInteger(catalog.missing_from_active_source_count) || catalog.missing_from_active_source_count < 0) {
    errors.push(`missing_from_active_source_count inválido: ${catalog.missing_from_active_source_count}`);
  }

  const active = Array.isArray(catalog.active) ? catalog.active : [];
  if (!runScraper && active.length !== catalog.active_count) {
    errors.push(`active.length (${active.length}) no coincide con active_count (${catalog.active_count})`);
  }

  const seenSlugs = new Set();
  const seenTitles = new Set();
  for (const [i, course] of active.entries()) {
    const label = `active[${i}]`;
    if (!course.title) errors.push(`${label}: falta title`);
    if (!course.slug) errors.push(`${label}: falta slug`);
    if (course.slug && seenSlugs.has(course.slug)) errors.push(`${label}: slug duplicado ${course.slug}`);
    if (course.slug) seenSlugs.add(course.slug);
    if (course.normalized_title && seenTitles.has(course.normalized_title)) warnings.push(`${label}: título normalizado duplicado ${course.title}`);
    if (course.normalized_title) seenTitles.add(course.normalized_title);
    if (!course.detail_url || !isValidHttpUrl(course.detail_url)) errors.push(`${label}: detail_url inválida`);
    if (course.signup_url && !isValidHttpUrl(course.signup_url)) errors.push(`${label}: signup_url inválida`);
    if (course.query_url && !isValidHttpUrl(course.query_url)) errors.push(`${label}: query_url inválida`);
    if (course.start_date && !/^\d{4}-\d{2}-\d{2}$/.test(course.start_date)) errors.push(`${label}: start_date inválida ${course.start_date}`);
  }

  if (catalog.new_unindexed_count > 0) {
    warnings.push(`Hay ${catalog.new_unindexed_count} cursos activos no indexados; revisar alta por PR.`);
  }
  if (catalog.missing_from_active_source_count > 0) {
    warnings.push(`Hay ${catalog.missing_from_active_source_count} cursos indexados que no aparecen activos; revisar baja/estado por PR.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      source,
      active_count: catalog.active_count,
      matched_count: catalog.matched_count,
      new_unindexed_count: catalog.new_unindexed_count,
      missing_from_active_source_count: catalog.missing_from_active_source_count,
    },
  };
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      catalog: { type: 'string' },
      'run-scraper': { type: 'boolean', default: false },
      'kb-root': { type: 'string', default: '../..' },
      out: { type: 'string', default: 'state/cursos-de-formacion' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia course catalog validator\n\nUso:\n  node validate_course_catalog.mjs --catalog=<catalog.json>\n  node validate_course_catalog.mjs --run-scraper\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const catalogPath = values.catalog ? (values.catalog.startsWith('/') ? values.catalog : resolve(here, values.catalog)) : null;

  const result = await validateCourseCatalog({
    catalogPath,
    runScraper: values['run-scraper'],
    kbRoot,
    stateDir,
  });

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exit(result.ok ? 0 : 1);
}

function printHuman(result) {
  console.log(`Course catalog validation: ${result.ok ? 'OK' : 'FAILED'}`);
  console.log(JSON.stringify(result.summary, null, 2));
  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
  if (result.errors.length) {
    console.error('\nErrors:');
    for (const error of result.errors) console.error(`- ${error}`);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
