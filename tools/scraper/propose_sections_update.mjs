// Genera una propuesta de actualización de secciones WordPress (ramas completas
// del sitio FCE: /academica/, /docentes/, /institucional/, /ciencia/,
// /extension/, /internacionales/) lista para PR humano o auto-merge.
//
// Análogo a propose_students_update.mjs, pero multi-sección y multi-MD:
//   - Por cada fuente con strategy 'fce-wordpress-section' (o la sección pedida),
//     crawlea la rama, y buildSectionCandidates produce UN MD por subpágina
//     importante (deterministicamente, sin IA por página).
//   - Materializa cada candidato en su indice_path bajo kbRoot y agrega la
//     entrada nueva a indice.json (category = displayName del sector).
//   - NUNCA borra documentos existentes si una sección queda vacía o falla.
//   - classifyDiff (IA o reglas) decide auto_merge vs requires_review por doc.
//   - Truncación del crawl o señales del candidato (datos personales / colisión
//     de ruta) fuerzan requires_review: no se auto-mergea contenido incompleto.
//   - Produce un resumen Markdown legible para usar como cuerpo del PR.
//
// Uso:
//   node propose_sections_update.mjs --kb-root=../.. --pr-body=/tmp/pr.md
//   node propose_sections_update.mjs --section=academica --dry-run
//   node propose_sections_update.mjs --force

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

import { scrapeBySource } from './scrape.mjs';
import { buildSectionCandidates } from './section_candidates.mjs';
import { classifyDiff } from './classify_diff.mjs';

const SECTION_STRATEGY = 'fce-wordpress-section';

export async function proposeSectionsUpdate({
  kbRoot,
  taxonomy,
  sources,
  sensitiveSections = [],
  section = null,
  threshold = 200,
  force = false,
  dryRun = false,
  today = todayIsoDate(),
  prBodyPath = null,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = 'gemini-2.5-pro',
  fetchImpl = fetch,
  regenerateRouting = true,
} = {}) {
  const sectionSources = (sources || []).filter(
    (s) => s.strategy === SECTION_STRATEGY && (!section || s.sectionId === section || s.slug === section),
  );

  if (sectionSources.length === 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: section
        ? `No hay fuente de sección '${section}' con strategy ${SECTION_STRATEGY} en sources.json.`
        : `No hay fuentes con strategy ${SECTION_STRATEGY} en sources.json.`,
      generated_on: today,
      sections: [],
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
  const sectionReports = [];
  let anyTruncated = false;
  let candidateReviewCount = 0;

  for (const source of sectionSources) {
    const sectionId = source.sectionId;
    const sector = taxonomy?.sectors?.[sectionId];
    if (!sector) {
      unsafeSkipped.push({ title: source.slug, path: null, reason: `sectionId '${sectionId}' desconocido en taxonomy` });
      continue;
    }

    let crawl;
    try {
      crawl = await scrapeBySource(source, { fetchImpl });
    } catch (err) {
      sectionReports.push({ section: sectionId, slug: source.slug, error: String(err.message || err), candidates_count: 0, truncated: false });
      continue;
    }

    const built = buildSectionCandidates(crawl, { sectionId, taxonomy, threshold, today });
    if (built.truncated) anyTruncated = true;

    sectionReports.push({
      section: sectionId,
      slug: source.slug,
      url: source.url,
      candidates_count: built.candidates.length,
      important_count: built.important_count,
      low_content_count: built.low_content_count,
      errored_count: built.errored_count,
      category_archive_count: built.category_archive_count,
      truncated: built.truncated,
      pending_links: built.pending_links,
      document_links: built.document_links,
      path_collisions: built.path_collisions,
    });

    for (const candidate of built.candidates) {
      const targetRelPath = normalizeSectionPath(candidate.indice_path, sector.kbFolder);
      if (!targetRelPath) {
        unsafeSkipped.push({ title: candidate.slug, path: candidate.indice_path || null, reason: `path inseguro o fuera de ${sector.kbFolder}/` });
        continue;
      }

      if (candidate.requires_review) candidateReviewCount++;

      const targetAbsPath = join(kbRoot, targetRelPath);
      const previousMarkdown = existsSync(targetAbsPath) ? await readFile(targetAbsPath, 'utf8') : null;

      if (previousMarkdown === candidate.markdown) {
        unchangedDocs.push(targetRelPath);
      } else {
        if (!dryRun) {
          await mkdir(dirname(targetAbsPath), { recursive: true });
          await writeFile(targetAbsPath, candidate.markdown, 'utf8');
        }
        if (previousMarkdown === null) createdDocs.push(targetRelPath);
        else updatedDocs.push(targetRelPath);

        const classification = await classifyDiff(candidate.markdown, previousMarkdown, { sensitiveSections, apiKey, model, fetchImpl });
        // Las señales del candidato (datos personales / colisión) fuerzan revisión.
        const decision = candidate.requires_review ? 'requires_review' : classification.decision;
        const reason = candidate.requires_review
          ? `señales del scraper: ${candidate.review_reasons.join('; ')}`
          : classification.reason;
        classifications.push({ path: targetRelPath, decision, reason, detailed_analysis: classification.detailed_analysis || '' });
      }

      if (!existingIndexPaths.has(targetRelPath)) {
        const entry = { path: targetRelPath, title: candidate.title || candidate.slug, category: sector.displayName };
        if (candidate.url) entry.canonicalUrl = candidate.url;
        addedIndexEntries.push(entry);
        existingIndexPaths.add(targetRelPath);
      }
    }
  }

  const summaryBase = {
    generated_on: today,
    sections: sectionReports,
    sections_count: sectionSources.length,
    candidates_count: createdDocs.length + updatedDocs.length + unchangedDocs.length,
    truncated: anyTruncated,
    candidate_review_count: candidateReviewCount,
  };

  if (unsafeSkipped.length > 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'Se detectaron paths inseguros o sectionId desconocido. No se abre PR automático hasta revisar el extractor/taxonomía.',
      dry_run: dryRun,
      force,
      created_docs: createdDocs,
      updated_docs: updatedDocs,
      unchanged_docs_count: unchangedDocs.length,
      added_index_entries: addedIndexEntries.map((e) => e.path),
      unsafe_skipped: unsafeSkipped,
      classifications,
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  const docsChanged = createdDocs.length > 0 || updatedDocs.length > 0;

  // Guard: ninguna sección produjo candidatos. No vaciamos nada (nunca borramos),
  // pero bloqueamos el PR vacío para que un humano revise por qué no hubo contenido.
  if (summaryBase.candidates_count === 0) {
    const result = {
      ok: false,
      decision: 'rejected',
      reason: 'Ninguna sección generó candidatos. Se bloquea la propuesta para evitar un PR vacío y revisar si el crawl falló.',
      dry_run: dryRun,
      force,
      created_docs: [],
      updated_docs: [],
      unchanged_docs_count: 0,
      added_index_entries: [],
      unsafe_skipped: [],
      classifications: [],
      ...summaryBase,
    };
    result.pr_summary = buildPrBody(result);
    await maybeWritePrBody(prBodyPath, result.pr_summary);
    return result;
  }

  const indexChanged = addedIndexEntries.length > 0 || docsChanged;
  let here = dirname(fileURLToPath(import.meta.url));
  if (indexChanged && !dryRun) {
    index.items = insertSectionEntries(index.items || [], addedIndexEntries);
    index.lastUpdated = today;
    if (Number.isInteger(index.version)) index.version += 1;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

    if (regenerateRouting) try {
      console.log('Regenerando routing_metadata.json por cambios en el índice...');
      execSync(`node "${join(here, 'generate_routing_metadata.mjs')}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Error al regenerar routing_metadata.json:', err.message);
    }
  }

  const hasProposal = force || docsChanged || addedIndexEntries.length > 0;
  let overallDecision = 'no_change';
  let overallReason = 'No hay cambios materiales para proponer.';

  if (hasProposal) {
    overallDecision = 'auto_merge';
    overallReason = 'Todos los cambios fueron clasificados como seguros para fusionar automáticamente.';

    const reviewDocs = classifications.filter((c) => c.decision === 'requires_review');
    if (reviewDocs.length > 0) {
      overallDecision = 'requires_review';
      overallReason = `Los siguientes archivos requieren revisión: ${reviewDocs.map((d) => d.path).join(', ')}`;
    }

    if (anyTruncated) {
      overallDecision = 'requires_review';
      overallReason = 'El crawl quedó truncado (se alcanzó maxPages/maxDepth): hay contenido descubierto pero no bajado. Revisar antes de mergear.';
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
    added_index_entries: addedIndexEntries.map((e) => e.path),
    unsafe_skipped: unsafeSkipped,
    classifications,
    commit_paths: ['indice.json', 'routing_metadata.json', ...uniqueFolders(addedIndexEntries, createdDocs, updatedDocs)],
    ...summaryBase,
  };
  result.pr_summary = buildPrBody(result);
  await maybeWritePrBody(prBodyPath, result.pr_summary);
  return result;
}

// Valida que el indice_path derivado caiga dentro del kbFolder del sector, sea
// .md y no escape con '..'//. Rechaza cualquier path fuera de su carpeta.
export function normalizeSectionPath(path, kbFolder) {
  if (!path || typeof path !== 'string') return null;
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  if (!normalized.endsWith('.md')) return null;
  if (normalized.includes('..') || normalized.includes('//')) return null;
  if (!normalized.startsWith(`${kbFolder}/`)) return null;
  return normalized;
}

// Inserta entradas nuevas agrupadas tras la última entrada existente de su misma
// carpeta (kbFolder); si la carpeta aún no existe en el índice, las agrega al final.
export function insertSectionEntries(items, newEntries) {
  if (!newEntries.length) return items;
  let next = [...items];
  const byFolder = new Map();
  for (const e of newEntries) {
    const folder = e.path.split('/')[0];
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(e);
  }
  for (const [folder, entries] of byFolder) {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'es-AR'));
    let lastIdx = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i]?.path?.startsWith(`${folder}/`)) lastIdx = i;
    }
    const insertionIndex = lastIdx >= 0 ? lastIdx + 1 : next.length;
    next.splice(insertionIndex, 0, ...sorted);
  }
  return next;
}

function uniqueFolders(addedEntries, created, updated) {
  const folders = new Set();
  for (const e of addedEntries) folders.add(`${e.path.split('/')[0]}/`);
  for (const p of [...created, ...updated]) folders.add(`${p.split('/')[0]}/`);
  return [...folders];
}

function buildPrBody(result) {
  const lines = [];
  lines.push('## Resumen automático — Secciones web FCE-UNL');
  lines.push('');
  if (result.decision === 'auto_merge') {
    lines.push('✨ **Este PR contiene cambios seguros y se fusionará automáticamente.**');
  } else if (result.decision === 'requires_review') {
    lines.push('⚠️ **Este PR requiere revisión manual antes de ser fusionado.**');
  } else if (result.decision === 'rejected') {
    lines.push('⛔ **Propuesta bloqueada. Ver motivo.**');
  } else {
    lines.push('No hay cambios para aplicar.');
  }
  lines.push('');
  lines.push(`- **Decisión**: \`${result.decision}\``);
  lines.push(`- **Motivo**: ${result.reason}`);
  lines.push(`- **Fecha de generación**: ${result.generated_on}`);
  lines.push(`- **Secciones procesadas**: ${result.sections_count ?? 0}`);
  lines.push(`- **MD candidatos (total)**: ${result.candidates_count ?? 0}`);
  lines.push(`- **Crawl truncado**: ${result.truncated ? 'sí ⚠️' : 'no'}`);
  lines.push(`- **Candidatos con señales de revisión**: ${result.candidate_review_count ?? 0}`);
  lines.push('');

  if (Array.isArray(result.sections) && result.sections.length) {
    lines.push('## Detalle por sección');
    lines.push('');
    for (const s of result.sections) {
      if (s.error) {
        lines.push(`### ⛔ \`${s.slug}\` (${s.section}) — error de crawl`);
        lines.push(`- ${s.error}`);
        lines.push('');
        continue;
      }
      lines.push(`### \`${s.slug}\` (${s.section})`);
      lines.push(`- Importantes: ${s.important_count ?? 0} · Flacas: ${s.low_content_count ?? 0} · Con error: ${s.errored_count ?? 0} · Archivos de categoría excluidos: ${s.category_archive_count ?? 0}`);
      lines.push(`- Documentos link-only: ${s.document_links?.length ?? 0}`);
      if (s.truncated) lines.push(`- ⚠️ Truncado: ${s.pending_links?.length ?? 0} links sin bajar (ampliar maxPages/maxDepth si hay contenido útil).`);
      if (s.path_collisions?.length) lines.push(`- ⚠️ Colisiones de ruta: ${s.path_collisions.length}`);
      lines.push('');
    }
  }

  if (result.classifications?.length > 0) {
    lines.push('## Análisis de cambios por documento');
    lines.push('');
    for (const c of result.classifications) {
      const icon = c.decision === 'auto_merge' ? '✅' : (c.decision === 'no_change' ? '➖' : '⚠️');
      lines.push(`### ${icon} \`${c.path}\` — \`${c.decision}\``);
      lines.push(`- **Motivo**: ${c.reason}`);
      if (c.detailed_analysis) lines.push(`- **Análisis**:\n\n  ${c.detailed_analysis.replace(/\n/g, '\n  ')}`);
      lines.push('');
    }
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

  if (result.unsafe_skipped?.length) {
    lines.push('## Elementos salteados por seguridad');
    lines.push('');
    for (const s of result.unsafe_skipped) lines.push(`- ${s.title || 'Sin título'} (${s.path || 'sin path'}): ${s.reason}`);
    lines.push('');
  }

  lines.push('## Cómo revisar');
  lines.push('');
  lines.push('1. Revisar el diff de los MD nuevos/actualizados en las carpetas de sector.');
  lines.push('2. Confirmar el criterio: un MD por subpágina importante; documentos y datos personales como enlaces, no ingeridos.');
  lines.push('3. Si el crawl quedó truncado, decidir si ampliar maxPages/maxDepth de la fuente.');
  lines.push('4. Verificar que `indice.json` solo agregue entradas necesarias y con la categoría correcta del sector.');
  lines.push('');
  return lines.join('\n');
}

function pushList(lines, title, values = []) {
  lines.push(`### ${title}`);
  lines.push('');
  if (!values.length) lines.push('- Ninguno.');
  else for (const value of values) lines.push(`- \`${value}\``);
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
      section: { type: 'string' },
      source: { type: 'string', default: 'sources.json' },
      threshold: { type: 'string', default: '200' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'pr-body': { type: 'string' },
      model: { type: 'string', default: 'gemini-2.5-pro' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia sections proposal generator

Uso:
  node propose_sections_update.mjs [--kb-root=../..] [--section=academica] [--force] [--dry-run] [--pr-body=/tmp/pr.md] [--threshold=200] [--model=gemini-2.5-pro]
`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const prBodyPath = values['pr-body'] ? resolve(process.cwd(), values['pr-body']) : null;

  const taxonomy = JSON.parse(await readFile(join(here, 'taxonomy.json'), 'utf8'));
  const sourcesPath = values.source.startsWith('/') ? values.source : join(here, values.source);
  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));

  const result = await proposeSectionsUpdate({
    kbRoot,
    taxonomy,
    sources: sourcesData.sources || [],
    sensitiveSections: sourcesData.sensitive_sections || [],
    section: values.section || null,
    threshold: Number.parseInt(values.threshold, 10) || 200,
    force: values.force,
    dryRun: values['dry-run'],
    prBodyPath,
    apiKey: process.env.GEMINI_API_KEY || '',
    model: values.model,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
