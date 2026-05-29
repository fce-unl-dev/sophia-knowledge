// Genera una propuesta de actualización de Estudiantes lista para PR humano o auto-merge.
//
// Contrato C.3:
//   - Ejecuta el scraper determinístico de /estudiantes/ organizado por temas del menú.
//   - Materializa candidatos como cambios en /estudiantes/ y entradas nuevas en indice.json.
//   - NO borra documentos existentes si una fuente queda vacía o falla.
//   - Produce un resumen Markdown legible para usar como cuerpo del PR.
//
// Uso:
//   node propose_students_update.mjs --kb-root=../.. --pr-body=/tmp/pr_body.md
//   node propose_students_update.mjs --kb-root=../.. --force
//   node propose_students_update.mjs --kb-root=../.. --dry-run

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

import { runStudentsScraper, STUDENT_TOPICS } from './scrape_students.mjs';
import { classifyDiff } from './classify_diff.mjs';

const STUDENT_CATEGORY = 'Estudiantes';
const DEFAULT_STATE_DIR = 'state/estudiantes';

export async function proposeStudentsUpdate({
  kbRoot,
  stateDir,
  force = false,
  dryRun = false,
  today = todayIsoDate(),
  prBodyPath = null,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = 'gemini-2.5-pro',
} = {}) {
  const scraperReport = await runStudentsScraper({
    stateDir,
    write: true,
    writeCandidates: true,
    today,
  });

  const catalog = JSON.parse(await readFile(scraperReport.catalog_path, 'utf8'));
  const summaryBase = buildSummaryBase({ scraperReport, catalog, today });

  if (catalog.candidates_count === 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'El scraper no generó candidatos de Estudiantes; se bloquea la propuesta para evitar vaciar o publicar contenido incompleto.',
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
      reason: 'El hash estable del catálogo de Estudiantes no cambió desde la última propuesta mergeada.',
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

  const topicsByPath = new Map(STUDENT_TOPICS.map((topic) => [topic.path, topic]));

  for (const candidate of catalog.candidates || []) {
    const targetRelPath = normalizeStudentPath(candidate.path);
    if (!targetRelPath) {
      unsafeSkipped.push({ title: candidate.slug, path: candidate.path || null, reason: 'path inválido o fuera de /estudiantes/' });
      continue;
    }

    const candidatePath = join(stateDir, 'candidates', candidate.candidate_file);
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
      const topic = topicsByPath.get(targetRelPath);
      const entry = {
        path: targetRelPath,
        title: topic?.title || candidate.slug,
        category: STUDENT_CATEGORY,
      };
      const canonicalUrl = topic?.pages?.[0]?.[1];
      if (canonicalUrl) entry.canonicalUrl = canonicalUrl;
      addedIndexEntries.push(entry);
      existingIndexPaths.add(targetRelPath);
    }
  }

  if (unsafeSkipped.length > 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'Se detectaron paths inseguros o fuera de /estudiantes/. No se debe abrir PR automático hasta revisar el extractor.',
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

  const docsChanged = createdDocs.length > 0 || updatedDocs.length > 0;
  const indexChanged = addedIndexEntries.length > 0 || docsChanged;
  if (indexChanged && !dryRun) {
    index.items = insertStudentEntries(index.items || [], addedIndexEntries);
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

  const hasProposal = force || scraperReport.status !== 'unchanged' || docsChanged || addedIndexEntries.length > 0;
  
  let overallDecision = 'no_change';
  let overallReason = 'No hay cambios materiales para proponer.';

  if (hasProposal) {
    overallDecision = 'auto_merge';
    overallReason = 'Todos los cambios fueron clasificados como seguros para fusionar automáticamente.';

    if (catalog.warnings?.length > 0) {
      overallDecision = 'requires_review';
      overallReason = 'Se detectaron warnings (advertencias) del scraper de estudiantes.';
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
    unchanged_docs_count: unchangedDocs.length,
    added_index_entries: addedIndexEntries.map((entry) => entry.path),
    unsafe_skipped: unsafeSkipped,
    classifications,
    commit_paths: [
      'indice.json',
      'estudiantes/',
      relative(kbRoot, scraperReport.meta_path),
    ],
    ...summaryBase,
  };

  result.pr_summary = buildPrBody(result);
  await maybeWritePrBody(prBodyPath, result.pr_summary);
  return result;
}

function normalizeStudentPath(path) {
  if (!path || typeof path !== 'string') return null;
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  if (!normalized.startsWith('estudiantes/') || !normalized.endsWith('.md')) return null;
  if (normalized.includes('..') || normalized.includes('//')) return null;
  return normalized;
}

function insertStudentEntries(items, newStudentEntries) {
  if (!newStudentEntries.length) return items;
  const sortedNewEntries = [...newStudentEntries].sort((a, b) => a.path.localeCompare(b.path, 'es-AR'));
  const next = [...items];
  let lastStudentIndex = -1;
  let lastOperativeIndex = -1;
  for (let i = 0; i < next.length; i++) {
    if (next[i]?.path?.startsWith('estudiantes/')) lastStudentIndex = i;
    if (next[i]?.path?.startsWith('operativos/')) lastOperativeIndex = i;
  }
  const insertionIndex = lastStudentIndex >= 0 ? lastStudentIndex + 1 : lastOperativeIndex + 1;
  next.splice(insertionIndex, 0, ...sortedNewEntries);
  return next;
}

function buildSummaryBase({ scraperReport, catalog, today }) {
  const requiresReview = (catalog.candidates || []).filter((candidate) => candidate.requires_review);
  const noContent = (catalog.processed || []).filter((topic) => topic.pages_with_content === 0);
  return {
    generated_on: today,
    scraper_status: scraperReport.status,
    topics_count: catalog.topics_count,
    candidates_count: catalog.candidates_count,
    excluded_count: catalog.excluded_count,
    warnings_count: catalog.warnings_count,
    requires_review_count: requiresReview.length,
    no_content_count: noContent.length,
    candidates_requiring_review: requiresReview,
    no_content_topics: noContent,
    excluded: catalog.excluded || [],
    warnings: catalog.warnings || [],
    content_hash: scraperReport.content_hash,
    previous_hash: scraperReport.previous_hash,
  };
}

function buildPrBody(result) {
  const lines = [];
  lines.push('## Resumen automático — Estudiantes FCE-UNL');
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
  lines.push(`- **Fecha de generación**: ${result.generated_on}`);
  lines.push(`- **Estado del scraper**: \`${result.scraper_status || 'N/D'}\``);
  lines.push(`- **Temas procesados**: ${result.topics_count ?? 0}`);
  lines.push(`- **MD candidatos generados**: ${result.candidates_count ?? 0}`);
  lines.push(`- **Temas excluidos explícitamente**: ${result.excluded_count ?? 0}`);
  lines.push(`- **Candidatos con señales de revisión**: ${result.requires_review_count ?? 0}`);
  lines.push(`- **Temas sin contenido útil detectado**: ${result.no_content_count ?? 0}`);
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
    pushList(lines, 'Entradas agregadas a `indice.json`', result.added_index_entries);
    lines.push(`- **Documentos sin cambios materiales**: ${result.unchanged_docs_count ?? 0}`);
    lines.push('');
  }

  if (result.candidates_requiring_review?.length) {
    lines.push('## Candidatos que requieren revisión especial');
    lines.push('');
    for (const candidate of result.candidates_requiring_review) {
      lines.push(`- **${candidate.slug}** → \`${candidate.path}\``);
      for (const reason of candidate.review_reasons || []) lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  if (result.no_content_topics?.length) {
    lines.push('## Temas sin contenido útil detectado');
    lines.push('');
    lines.push('Estos temas no generan MD automáticamente. Revisar si la página está vacía, si cambió la URL o si conviene excluirla.');
    lines.push('');
    for (const topic of result.no_content_topics) lines.push(`- ${topic.title || topic.slug} → \`${topic.indice_path || 'sin path'}\``);
    lines.push('');
  }

  if (result.excluded?.length) {
    lines.push('## Exclusiones explícitas');
    lines.push('');
    for (const excluded of result.excluded) {
      lines.push(`- ${excluded.title}: ${excluded.reason}`);
      if (excluded.url) lines.push(`  - Fuente excluida: ${excluded.url}`);
    }
    lines.push('');
  }

  if (result.warnings?.length) {
    lines.push('## Warnings del extractor');
    lines.push('');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
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
  lines.push('1. Revisar el diff de los archivos en `/estudiantes/`.');
  lines.push('2. Confirmar que cada MD respete el criterio: un tema/título del menú por documento.');
  lines.push('3. Editar el PR si hay contenido vacío, repetido, obsoleto o sensible.');
  lines.push('4. Verificar que `indice.json` solo agregue entradas necesarias y no duplique información.');
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
    console.log(`Sophia students proposal generator\n\nUso:\n  node propose_students_update.mjs [--kb-root=../..] [--force] [--dry-run] [--pr-body=/tmp/pr.md] [--model=gemini-2.5-pro]\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const stateDir = values.out.startsWith('/') ? values.out : resolve(here, values.out);
  const prBodyPath = values['pr-body'] ? resolve(process.cwd(), values['pr-body']) : null;
  const reportOutPath = values['report-out'] ? resolve(process.cwd(), values['report-out']) : null;

  const result = await proposeStudentsUpdate({
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
