// Validador del índice publicado del KB de Sophia.
//
// Checks sin red:
//   - indice.json parsea y tiene estructura mínima.
//   - paths únicos, seguros y existentes.
//   - títulos/categorías presentes.
//   - canonicalUrl con formato URL cuando existe.
//   - no se reintroduce cursos/cursos-de-formacion-activos.md.
//   - no hay documento agregado en /cursos/.
//
// Uso:
//   node tools/scraper/validate_index.mjs
//   node tools/scraper/validate_index.mjs --kb-root=/path/to/repo

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const FORBIDDEN_INDEX_PATHS = new Set([
  'cursos/cursos-de-formacion-activos.md',
]);

const ALLOWED_TOP_LEVEL_DIRS = new Set([
  'posgrados',
  'diplomaturas',
  'compartidos',
  'operativos',
  'cursos',
  'posgrado-general',
  'estudiantes',
  'complementos',
]);

const COURSE_AGGREGATE_BASENAMES = new Set([
  'cursos-de-formacion',
  'cursos-de-formacion-activos',
  'cursos-activos',
  'listado-de-cursos',
  'listado-cursos',
  'overview',
  'cursos-overview',
]);

export async function validateIndex({ kbRoot } = {}) {
  const errors = [];
  const warnings = [];
  const indexPath = join(kbRoot, 'indice.json');

  if (!existsSync(indexPath)) {
    return { ok: false, errors: [`No existe indice.json en ${kbRoot}`], warnings, summary: {} };
  }

  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`indice.json no parsea como JSON: ${err.message}`], warnings, summary: {} };
  }

  if (!Number.isInteger(index.version) || index.version < 1) {
    errors.push('indice.json debe tener version numérica entera >= 1');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(index.lastUpdated || '')) {
    errors.push('indice.json debe tener lastUpdated en formato YYYY-MM-DD');
  }
  if (!Array.isArray(index.items)) {
    errors.push('indice.json debe tener items como array');
  }

  const items = Array.isArray(index.items) ? index.items : [];

  const routingPath = join(kbRoot, 'routing_metadata.json');
  let routingMetadata;
  if (!existsSync(routingPath)) {
    errors.push(`No existe routing_metadata.json en ${kbRoot}. Ejecute 'node tools/scraper/generate_routing_metadata.mjs'`);
  } else {
    try {
      routingMetadata = JSON.parse(await readFile(routingPath, 'utf8'));
    } catch (err) {
      errors.push(`routing_metadata.json no parsea como JSON: ${err.message}`);
    }
  }

  const seenPaths = new Map();
  const seenTitles = new Map();
  const categoryCounts = new Map();
  const topLevelCounts = new Map();

  for (const [i, item] of items.entries()) {
    const label = `items[${i}]`;
    const path = item?.path;
    const title = item?.title;
    const category = item?.category;

    if (!path || typeof path !== 'string') {
      errors.push(`${label}: falta path string`);
      continue;
    }
    if (!title || typeof title !== 'string') errors.push(`${path}: falta title string`);
    if (!category || typeof category !== 'string') errors.push(`${path}: falta category string`);

    if (!path.endsWith('.md')) errors.push(`${path}: path debe terminar en .md`);
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      errors.push(`${path}: path inseguro; debe ser relativo al repo sin .. ni backslashes`);
    }
    if (FORBIDDEN_INDEX_PATHS.has(path)) {
      errors.push(`${path}: path prohibido; duplica el modelo 1 MD por curso`);
    }

    const topLevel = path.split('/')[0];
    topLevelCounts.set(topLevel, (topLevelCounts.get(topLevel) || 0) + 1);
    if (!ALLOWED_TOP_LEVEL_DIRS.has(topLevel)) {
      warnings.push(`${path}: directorio top-level no reconocido; revisar si debe agregarse al contrato`);
    }

    if (seenPaths.has(path)) {
      errors.push(`${path}: path duplicado; también aparece en items[${seenPaths.get(path)}]`);
    } else {
      seenPaths.set(path, i);
    }

    const normalizedTitle = normalizeTitle(title || '');
    if (normalizedTitle) {
      if (seenTitles.has(normalizedTitle)) {
        warnings.push(`${path}: título potencialmente duplicado con items[${seenTitles.get(normalizedTitle)}] (${title})`);
      } else {
        seenTitles.set(normalizedTitle, i);
      }
    }

    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);

    const absolutePath = join(kbRoot, path);
    if (!existsSync(absolutePath)) {
      errors.push(`${path}: archivo listado en indice.json no existe`);
    } else if (!statSync(absolutePath).isFile()) {
      errors.push(`${path}: path existe pero no es archivo`);
    }

    if (item.canonicalUrl !== undefined) {
      if (typeof item.canonicalUrl !== 'string' || !isValidHttpUrl(item.canonicalUrl)) {
        errors.push(`${path}: canonicalUrl inválida`);
      }
    }

    if (routingMetadata) {
      const mapping = routingMetadata.mappings?.[path];
      if (!mapping) {
        errors.push(`${path}: no está mapeado en routing_metadata.json. Ejecute 'node tools/scraper/generate_routing_metadata.mjs'`);
      } else {
        const allowedSectors = new Set([
          'posgrados_graduados',
          'grado',
          'posgrados_cursos_sin_titulo',
          'docentes',
          'tramites_bedelia'
        ]);
        if (!allowedSectors.has(mapping.sector)) {
          errors.push(`${path}: tiene un sector de ruteo inválido: '${mapping.sector}'`);
        }
      }
    }
  }

  const courseItems = items.filter((item) => item.path?.startsWith('cursos/') && item.path?.endsWith('.md'));
  for (const item of courseItems) {
    const basename = item.path.replace(/^cursos\//, '');
    if (isCourseAggregateBasename(basename)) {
      errors.push(`${item.path}: los cursos deben mantenerse como 1 MD por curso, no como agregado/listado`);
    }
  }

  await warnAboutUnindexedMarkdown({ kbRoot, indexedPaths: new Set(items.map((item) => item.path)), warnings });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      version: index.version,
      lastUpdated: index.lastUpdated,
      items: items.length,
      categories: Object.fromEntries([...categoryCounts.entries()].sort()),
      topLevel: Object.fromEntries([...topLevelCounts.entries()].sort()),
    },
  };
}

async function warnAboutUnindexedMarkdown({ kbRoot, indexedPaths, warnings }) {
  for (const dir of ALLOWED_TOP_LEVEL_DIRS) {
    const absDir = join(kbRoot, dir);
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) continue;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relative = `${dir}/${entry.name}`;
      if (!indexedPaths.has(relative)) {
        warnings.push(`${relative}: existe en repo pero no está listado en indice.json`);
      }
    }
  }
}

function isCourseAggregateBasename(basename) {
  const stem = basename.replace(/\.md$/i, '').toLocaleLowerCase('es-AR');
  return COURSE_AGGREGATE_BASENAMES.has(stem);
}

function normalizeTitle(value) {
  return String(value)
    .toLocaleLowerCase('es-AR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      'kb-root': { type: 'string', default: '../..' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia KB index validator\n\nUso:\n  node validate_index.mjs [--kb-root=../..] [--json]\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const result = await validateIndex({ kbRoot });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  process.exit(result.ok ? 0 : 1);
}

function printHuman(result) {
  console.log(`KB index validation: ${result.ok ? 'OK' : 'FAILED'}`);
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
