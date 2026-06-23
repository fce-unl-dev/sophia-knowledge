// Genera una propuesta de actualización de cursos lista para PR humano o auto-merge.
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

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

import { runCoursesScraper } from './scrape_courses.mjs';
import { classifyDiff } from './classify_diff.mjs';

const COURSE_CATEGORY = 'Curso de formación profesional';
const DEFAULT_STATE_DIR = 'state/cursos-de-formacion';

export async function proposeCoursesUpdate({
  kbRoot,
  stateDir,
  force = false,
  dryRun = false,
  today = todayIsoDate(),
  prBodyPath = null,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = 'gemini-2.5-pro',
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

  const here = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = join(here, 'sources.json');
  const sourcesData = existsSync(sourcesPath) ? JSON.parse(await readFile(sourcesPath, 'utf8')) : {};
  const sensitiveSections = sourcesData.sensitive_sections || [];

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
  const classifications = [];

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

      // Clasificación de diff por IA o reglas
      const classification = await classifyDiff(candidateMarkdown, previousMarkdown, {
        sensitiveSections,
        apiKey,
        model,
      });
      classifications.push({
        path: targetRelPath,
        decision: classification.decision,
        reason: classification.reason,
        detailed_analysis: classification.detailed_analysis || '',
      });
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
      classifications,
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  // --- BAJAS: el KB debe reflejar la web. Cursos en indice.json (cursos/) que ya
  // no figuran activos en la fuente se ELIMINAN automáticamente (archivo + índice).
  // Guarda de seguridad: el scrape vacío (active_count===0) ya cortó arriba con
  // 'rejected'. Si las bajas SUPERAN a los cursos activos, es señal de un scrape
  // parcial anómalo → se deriva a revisión humana en vez de borrar masivamente.
  const bajas = catalog.missing_from_active_source || [];
  const removedDocs = [];
  const bajasAnomaly = bajas.length > 0 && bajas.length > (catalog.active_count || 0);
  if (bajas.length > 0 && !bajasAnomaly) {
    const bajaPaths = new Set(bajas.map((b) => normalizeCoursePath(b.path)).filter(Boolean));
    for (const relPath of bajaPaths) {
      const abs = join(kbRoot, relPath);
      if (!dryRun && existsSync(abs)) await rm(abs);
      removedDocs.push(relPath);
    }
    index.items = (index.items || []).filter((it) => !bajaPaths.has(it.path));
  }

  const docsChanged = createdDocs.length > 0 || updatedDocs.length > 0;
  const indexChanged = addedIndexEntries.length > 0 || docsChanged || removedDocs.length > 0;
  if (indexChanged && !dryRun) {
    index.items = insertCourseEntries(index.items || [], addedIndexEntries);
    index.lastUpdated = today;
    if (Number.isInteger(index.version)) index.version += 1;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

    try {
      console.log('Regenerando routing_metadata.json por cambios en el índice...');
      execSync(`node "${join(here, 'generate_routing_metadata.mjs')}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Error al regenerar routing_metadata.json:', err.message);
    }
  }

  const hasProposal = force || scraperReport.status !== 'unchanged' || docsChanged
    || addedIndexEntries.length > 0 || removedDocs.length > 0 || bajasAnomaly;

  let overallDecision = 'no_change';
  let overallReason = 'No hay cambios materiales para proponer.';

  if (hasProposal) {
    overallDecision = 'auto_merge';
    overallReason = 'Cambios de cursos clasificados como seguros (altas, actualizaciones y/o bajas que reflejan la web).';

    if (bajasAnomaly) {
      overallDecision = 'requires_review';
      overallReason = `Anomalía de seguridad: ${bajas.length} bajas frente a ${catalog.active_count} cursos activos. No se borra masivamente sin revisión humana.`;
    }

    const reviewRequiredDocs = classifications.filter((c) => c.decision === 'requires_review');
    if (reviewRequiredDocs.length > 0) {
      overallDecision = 'requires_review';
      const paths = reviewRequiredDocs.map((d) => d.path).join(', ');
      overallReason = `Los siguientes archivos requieren revisión: ${paths}`;
    }
  }

  const result = {
    ok: true,
    decision: overallDecision,
    reason: overallReason,
    dry_run: dryRun,
    force,
    created_docs: createdDocs,
    updated_docs: updatedDocs,
    removed_docs: removedDocs,
    unchanged_docs_count: unchangedDocs.length,
    added_index_entries: addedIndexEntries.map((entry) => entry.path),
    unsafe_skipped: unsafeSkipped,
    classifications,
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
  if (result.decision === 'auto_merge') {
    lines.push('✨ **Este PR contiene cambios seguros y se fusionará automáticamente.**');
  } else if (result.decision === 'requires_review') {
    lines.push('⚠️ **Este PR requiere revisión manual antes de ser fusionado.**');
  } else {
    lines.push('No hay cambios para aplicar.');
  }
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

  if (result.classifications?.length > 0) {
    lines.push('## Análisis de Cambios por IA');
    lines.push('');
    for (const c of result.classifications) {
      const icon = c.decision === 'auto_merge' ? '✅' : '⚠️';
      lines.push(`### ${icon} \`${c.path}\` — Decisión: \`${c.decision}\``);
      lines.push(`- **Motivo**: ${c.reason}`);
      if (c.detailed_analysis) {
        lines.push(`- **Análisis detallado**:\n\n  ${c.detailed_analysis.replace(/\n/g, '\n  ')}`);
      }
      lines.push('');
    }
    lines.push('');
  }

  if (Array.isArray(result.created_docs)) {
    lines.push('## Cambios propuestos en archivos');
    lines.push('');
    pushList(lines, 'Documentos creados', result.created_docs);
    pushList(lines, 'Documentos actualizados', result.updated_docs);
    pushList(lines, 'Documentos eliminados (bajas, ya no están en la web)', result.removed_docs);
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
    lines.push('## Bajas (cursos que ya no están en la web)');
    lines.push('');
    if (result.removed_docs?.length) {
      lines.push('Estos cursos ya no figuran en el listado oficial y **fueron eliminados del KB** para que coincida con la web:');
    } else {
      lines.push('Estos cursos no aparecieron en el listado activo (no se eliminaron por la guarda de seguridad de anomalía):');
    }
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
  lines.push('5. Si todo está correcto y requiere revisión humana, merge manual. Si hay dudas, comentar el PR.');
  lines.push('');
  lines.push('## Política de Auto-Merge');
  lines.push('');
  lines.push('Si la decisión general es `auto_merge`, este PR será fusionado automáticamente por GitHub Actions una vez superadas las validaciones.');
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
      'report-out': { type: 'string' },
      model: { type: 'string', default: 'gemini-2.5-pro' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia courses proposal generator\n\nUso:\n  node propose_courses_update.mjs [--kb-root=../..] [--force] [--dry-run] [--pr-body=/tmp/pr.md] [--model=gemini-2.5-pro]\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const prBodyPath = values['pr-body'] ? resolve(process.cwd(), values['pr-body']) : null;
  const reportOutPath = values['report-out'] ? resolve(process.cwd(), values['report-out']) : null;

  const result = await proposeCoursesUpdate({
    kbRoot,
    stateDir,
    force: values.force,
    dryRun: values['dry-run'],
    prBodyPath,
    apiKey: process.env.GEMINI_API_KEY || '',
    model: values.model,
  });

  // El reporte JSON va a un archivo dedicado (consumido por el workflow con jq).
  // No depende de la pureza del stdout, que puede tener logs de progreso.
  const reportJson = JSON.stringify(result, null, 2);
  if (reportOutPath) {
    await writeFile(reportOutPath, reportJson, 'utf8');
  }
  console.log(reportJson);
  process.exit(0);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
