// Genera una propuesta de actualización de cursos lista para PR humano.
//
// Contrato B.5:
//   - Ejecuta el scraper determinístico de cursos.
//   - Materializa candidatos como cambios en /cursos/ y, si hay altas, en indice.json.
//   - NO borra cursos indexados que ya no aparezcan activos; los reporta para revisión.
//   - Produce un resumen Markdown legible para usar como cuerpo del PR.
//
// Uso:
//   node propose_courses_update.mjs --kb-root=../.. --pr-body=/tmp/pr_body.md
//   node propose_courses_update.mjs --kb-root=../.. --force
//   node propose_courses_update.mjs --kb-root=../.. --dry-run

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runCoursesScraper } from './scrape_courses.mjs';

const COURSE_CATEGORY = 'Curso de formación profesional';
const DEFAULT_STATE_DIR = 'state/cursos-de-formacion';

export async function proposeCoursesUpdate({
  kbRoot,
  stateDir,
  force = false,
  dryRun = false,
  today = todayIsoDate(),
  prBodyPath = null,
} = {}) {
  const scraperReport = await runCoursesScraper({
    stateDir,
    kbRoot,
    write: true,
    writeCandidates: true,
    today,
  });

  const catalog = JSON.parse(await readFile(scraperReport.catalog_path, 'utf8'));
  const summaryBase = buildSummaryBase({ scraperReport, catalog, today });

  if (catalog.active_count === 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'El scraper no detectó cursos activos; se bloquea la propuesta para evitar borrar o vaciar contenido por error.',
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  if (scraperReport.status === 'unchanged' && !force) {
    const result = {
      ok: true,
      decision: 'no_change',
      reason: 'El hash estable del catálogo de cursos no cambió desde la última propuesta mergeada.',
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  const indexPath = join(kbRoot, 'indice.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const existingIndexPaths = new Set((index.items || []).map((item) => item.path));

  const createdDocs = [];
  const updatedDocs = [];
  const unchangedDocs = [];
  const addedIndexEntries = [];
  const unsafeSkipped = [];

  for (const course of catalog.active) {
    const targetRelPath = normalizeCoursePath(course.index_path || `cursos/${course.slug}.md`);
    if (!targetRelPath) {
      unsafeSkipped.push({ title: course.title, path: course.index_path || null, reason: 'path inválido o fuera de /cursos/' });
      continue;
    }

    const candidatePath = join(stateDir, 'candidates', `${course.slug}.candidate.md`);
    const candidateMarkdown = await readFile(candidatePath, 'utf8');
    const targetAbsPath = join(kbRoot, targetRelPath);
    const previousMarkdown = existsSync(targetAbsPath) ? await readFile(targetAbsPath, 'utf8') : null;

    if (previousMarkdown === candidateMarkdown) {
      unchangedDocs.push(targetRelPath);
    } else {
      if (!dryRun) {
        await mkdir(dirname(targetAbsPath), { recursive: true });
        await writeFile(targetAbsPath, candidateMarkdown, 'utf8');
      }
      if (previousMarkdown === null) createdDocs.push(targetRelPath);
      else updatedDocs.push(targetRelPath);
    }

    if (!existingIndexPaths.has(targetRelPath)) {
      const entry = {
        path: targetRelPath,
        title: course.title,
        category: COURSE_CATEGORY,
      };
      if (course.detail_url) entry.canonicalUrl = course.detail_url;
      addedIndexEntries.push(entry);
      existingIndexPaths.add(targetRelPath);
    }
  }

  if (unsafeSkipped.length > 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'Se detectaron paths inseguros o fuera de /cursos/. No se debe abrir PR automático hasta revisar el scraper.',
      dry_run: dryRun,
      force,
      created_docs: createdDocs,
      updated_docs: updatedDocs,
      unchanged_docs_count: unchangedDocs.length,
      added_index_entries: addedIndexEntries.map((entry) => entry.path),
      unsafe_skipped: unsafeSkipped,
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  const docsChanged = createdDocs.length > 0 || updatedDocs.length > 0;
  const indexChanged = addedIndexEntries.length > 0 || docsChanged;
  if (indexChanged && !dryRun) {
    index.items = insertCourseEntries(index.items || [], addedIndexEntries);
    index.lastUpdated = today;
    if (Number.isInteger(index.version)) index.version += 1;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  }

  const hasProposal = force || scraperReport.status !== 'unchanged' || docsChanged || addedIndexEntries.length > 0;
  const result = {
    ok: true,
    decision: hasProposal ? 'changes_proposed' : 'no_change',
    reason: hasProposal
      ? 'Se generó una propuesta de actualización para revisión humana.'
      : 'No hay cambios materiales para proponer.',
    dry_run: dryRun,
    force,
    created_docs: createdDocs,
    updated_docs: updatedDocs,
    unchanged_docs_count: unchangedDocs.length,
    added_index_entries: addedIndexEntries.map((entry) => entry.path),
    unsafe_skipped: unsafeSkipped,
    commit_paths: [
      'indice.json',
      'cursos/',
      relative(kbRoot, scraperReport.meta_path),
    ],
    ...summaryBase,
  };

  result.pr_summary = buildPrBody(result);
  await maybeWritePrBody(prBodyPath, result.pr_summary);
  return result;
}

function normalizeCoursePath(path) {
  if (!path || typeof path !== 'string') return null;
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  if (!normalized.startsWith('cursos/') || !normalized.endsWith('.md')) return null;
  if (normalized.includes('..') || normalized.includes('//')) return null;
  return normalized;
}

function insertCourseEntries(items, newCourseEntries) {
  if (!newCourseEntries.length) return items;
  const sortedNewEntries = [...newCourseEntries].sort((a, b) => a.path.localeCompare(b.path, 'es-AR'));
  const next = [...items];
  let lastCourseIndex = -1;
  for (let i = 0; i < next.length; i++) {
    if (next[i]?.path?.startsWith('cursos/')) lastCourseIndex = i;
  }
  next.splice(lastCourseIndex + 1, 0, ...sortedNewEntries);
  return next;
}

function buildSummaryBase({ scraperReport, catalog, today }) {
  return {
    generated_on: today,
    source_url: catalog.source_url,
    scraper_status: scraperReport.status,
    active_count: catalog.active_count,
    matched_count: catalog.matched_count,
    new_unindexed_count: catalog.new_unindexed_count,
    missing_from_active_source_count: catalog.missing_from_active_source_count,
    new_unindexed: catalog.new_unindexed,
    missing_from_active_source: catalog.missing_from_active_source,
    content_hash: scraperReport.content_hash,
    previous_hash: scraperReport.previous_hash,
  };
}

function buildPrBody(result) {
  const lines = [];
  lines.push('## Resumen automático — cursos de formación profesional');
  lines.push('');
  lines.push('Este PR fue generado por el scraper determinístico de cursos. No se mergea automáticamente y debe revisarse antes de entrar a `main`.');
  lines.push('');
  lines.push(`- **Decisión**: \`${result.decision}\``);
  lines.push(`- **Motivo**: ${result.reason}`);
  lines.push(`- **Fuente oficial**: ${result.source_url || 'N/D'}`);
  lines.push(`- **Fecha de generación**: ${result.generated_on}`);
  lines.push(`- **Estado del scraper**: \`${result.scraper_status || 'N/D'}\``);
  lines.push(`- **Cursos activos detectados**: ${result.active_count ?? 0}`);
  lines.push(`- **Cursos ya indexados y matcheados**: ${result.matched_count ?? 0}`);
  lines.push(`- **Cursos nuevos no indexados**: ${result.new_unindexed_count ?? 0}`);
  lines.push(`- **Cursos indexados que no figuran activos en la fuente**: ${result.missing_from_active_source_count ?? 0}`);
  lines.push('');

  if (Array.isArray(result.created_docs)) {
    lines.push('## Cambios propuestos en archivos');
    lines.push('');
    pushList(lines, 'Documentos creados', result.created_docs);
    pushList(lines, 'Documentos actualizados', result.updated_docs);
    pushList(lines, 'Entradas agregadas a `indice.json`', result.added_index_entries);
    lines.push(`- **Documentos sin cambios materiales**: ${result.unchanged_docs_count ?? 0}`);
    lines.push('');
  }

  if (result.new_unindexed?.length) {
    lines.push('## Altas detectadas');
    lines.push('');
    for (const course of result.new_unindexed) {
      lines.push(`- **${course.title}** → \`${course.proposed_index_path}\``);
      if (course.detail_url) lines.push(`  - Fuente: ${course.detail_url}`);
    }
    lines.push('');
  }

  if (result.missing_from_active_source?.length) {
    lines.push('## Bajas o cursos no activos en la fuente');
    lines.push('');
    lines.push('Estos cursos están en `indice.json`, pero no aparecieron en el listado activo. **No se eliminan automáticamente**; solo quedan reportados para decisión humana.');
    lines.push('');
    for (const course of result.missing_from_active_source) {
      lines.push(`- ${course.title} → \`${course.path}\``);
    }
    lines.push('');
  }

  if (result.unsafe_skipped?.length) {
    lines.push('## Elementos salteados por seguridad');
    lines.push('');
    for (const skipped of result.unsafe_skipped) {
      lines.push(`- ${skipped.title || 'Sin título'} (${skipped.path || 'sin path'}): ${skipped.reason}`);
    }
    lines.push('');
  }

  lines.push('## Cómo revisar');
  lines.push('');
  lines.push('1. Revisar el diff de los archivos en `/cursos/`.');
  lines.push('2. Confirmar altas nuevas contra la fuente oficial.');
  lines.push('3. Revisar si los cursos listados como no activos deben mantenerse, archivarse o eliminarse en un PR posterior.');
  lines.push('4. Verificar que `indice.json` solo agregue entradas necesarias y no duplique cursos.');
  lines.push('5. Si todo está correcto, merge manual. Si hay dudas, comentar el PR y no mergear.');
  lines.push('');
  lines.push('## Política vigente');
  lines.push('');
  lines.push('- Detección y propuesta automática vía PR.');
  lines.push('- Sin merge automático.');
  lines.push('- Sin push directo a producción.');
  lines.push('- Los cursos se mantienen como **1 MD por curso**.');
  lines.push('');

  return lines.join('\n');
}

function pushList(lines, title, values = []) {
  lines.push(`### ${title}`);
  lines.push('');
  if (!values.length) {
    lines.push('- Ninguno.');
  } else {
    for (const value of values) lines.push(`- \`${value}\``);
  }
  lines.push('');
}

async function maybeWritePrBody(path, body) {
  if (!path) return;
  await writeFile(path, body || '', 'utf8');
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '../..' },
      out: { type: 'string', default: DEFAULT_STATE_DIR },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'pr-body': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia courses proposal generator\n\nUso:\n  node propose_courses_update.mjs [--kb-root=../..] [--force] [--dry-run] [--pr-body=/tmp/pr.md]\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const prBodyPath = values['pr-body'] ? resolve(process.cwd(), values['pr-body']) : null;

  const result = await proposeCoursesUpdate({
    kbRoot,
    stateDir,
    force: values.force,
    dryRun: values['dry-run'],
    prBodyPath,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
