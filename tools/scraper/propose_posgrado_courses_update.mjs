// Orquestador de propuestas para CURSOS DE POSGRADO.
//
// - Corre el scraper determinístico (scrape_courses_posgrado.mjs).
// - Materializa SOLO los cursos NUEVOS (cuyo MD aún no existe) en /cursos-posgrado/
//   y los agrega a indice.json. NO pisa fichas existentes (preserva el contenido
//   curado a mano); para cursos ya presentes solo reporta drift de fecha de inicio.
// - NO borra cursos que dejaron de estar activos; los reporta como bajas (revisión).
// - Clasifica cada alta con classify_diff (IA si hay GEMINI_API_KEY).
// - Produce un cuerpo de PR Markdown y un report JSON con .decision.
//
// Uso:
//   node propose_posgrado_courses_update.mjs --kb-root=../.. --pr-body=/tmp/pr.md --report-out=/tmp/r.json [--force] [--dry-run]

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

import { runPosgradoCoursesScraper, todayIsoDate } from './scrape_courses_posgrado.mjs';
import { classifyDiff } from './classify_diff.mjs';

const CATEGORY = 'Curso de posgrado';
const KB_FOLDER = 'cursos-posgrado';
const DEFAULT_STATE_DIR = 'state/cursos-posgrado';

export async function proposePosgradoCoursesUpdate({
  kbRoot,
  stateDir,
  force = false,
  dryRun = false,
  today = todayIsoDate(),
  prBodyPath = null,
  reportOutPath = null,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = 'gemini-2.5-pro',
  fetchImpl = fetch,
} = {}) {
  const here = dirname(fileURLToPath(import.meta.url));

  const scraper = await runPosgradoCoursesScraper({
    kbRoot, stateDir, today, writeCandidates: true, fetchImpl,
  });

  if (scraper.active_count === 0) {
    return finalize({
      ok: false, decision: 'rejected',
      reason: 'El scraper no detectó cursos de posgrado activos; se bloquea para no borrar contenido por error.',
      today,
    }, { prBodyPath, reportOutPath });
  }

  const indexPath = join(kbRoot, 'indice.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const existingPaths = new Set((index.items || []).map((i) => i.path));

  const sourcesPath = join(here, 'sources.json');
  const sourcesData = existsSync(sourcesPath) ? JSON.parse(await readFile(sourcesPath, 'utf8')) : {};
  const sensitiveSections = sourcesData.sensitive_sections || [];

  const createdDocs = [];
  const addedIndexEntries = [];
  const existingCourses = [];
  const dateDrift = [];
  const classifications = [];

  for (const course of scraper.courses) {
    const relPath = course.kb_path; // cursos-posgrado/<slug>.md
    const absPath = join(kbRoot, relPath);

    if (existsSync(absPath) || existingPaths.has(relPath)) {
      // Curso ya curado: NO se pisa. Solo se reporta posible drift de fecha.
      existingCourses.push(relPath);
      if (course.start_date_iso && existsSync(absPath)) {
        const cur = await readFile(absPath, 'utf8');
        if (course.start_date_raw && !cur.includes(course.start_date_raw) &&
            (!course.start_date_iso || !cur.includes(course.start_date_iso))) {
          dateDrift.push({ path: relPath, listing_start: course.start_date_raw });
        }
      }
      continue;
    }

    // Curso NUEVO → materializar candidato.
    const candidatePath = join(stateDir, 'candidates', `${course.slug}.candidate.md`);
    const candidateMd = await readFile(candidatePath, 'utf8');
    if (!dryRun) {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, candidateMd, 'utf8');
    }
    createdDocs.push(relPath);

    const classification = await classifyDiff(candidateMd, null, { sensitiveSections, apiKey, model });
    classifications.push({ path: relPath, decision: classification.decision, reason: classification.reason });

    addedIndexEntries.push({
      path: relPath,
      title: course.title,
      category: CATEGORY,
      canonicalUrl: 'https://www.fce.unl.edu.ar/academica/categorias/propuesta/cursos-de-posgrado-propuesta/',
    });
    existingPaths.add(relPath);
  }

  // Bajas: cursos en el índice (cursos-posgrado/) que ya no están activos en la
  // fuente → se ELIMINAN automáticamente (archivo + índice) para que el KB
  // coincida con la web. Guarda: si las bajas superan a los activos, es una
  // anomalía (scrape parcial) → revisión humana, sin borrar masivamente.
  const activePaths = new Set(scraper.courses.map((c) => c.kb_path));
  const missingFromSource = (index.items || [])
    .filter((i) => i.path.startsWith(`${KB_FOLDER}/`) && !activePaths.has(i.path))
    .map((i) => ({ path: i.path, title: i.title }));
  const bajasAnomaly = missingFromSource.length > 0 && missingFromSource.length > scraper.active_count;
  const removedDocs = [];
  if (missingFromSource.length > 0 && !bajasAnomaly) {
    for (const baja of missingFromSource) {
      const abs = join(kbRoot, baja.path);
      if (!dryRun && existsSync(abs)) await rm(abs);
      removedDocs.push(baja.path);
    }
    const removedSet = new Set(removedDocs);
    index.items = (index.items || []).filter((it) => !removedSet.has(it.path));
  }

  const hasNew = createdDocs.length > 0;
  const indexChanged = hasNew || removedDocs.length > 0;

  if (indexChanged && !dryRun) {
    index.items = [...(index.items || []), ...addedIndexEntries]
      .sort((a, b) => a.path.localeCompare(b.path, 'es-AR'));
    index.lastUpdated = today;
    if (Number.isInteger(index.version)) index.version += 1;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
    try {
      execSync(`node "${join(here, 'generate_routing_metadata.mjs')}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Error al regenerar routing_metadata.json:', err.message);
    }
  }

  // Decisión global.
  let decision = 'no_change';
  let reason = 'No hay cambios de cursos de posgrado (ni altas ni bajas).';
  if (hasNew || removedDocs.length > 0 || bajasAnomaly || (force && scraper.active_count > 0)) {
    decision = 'auto_merge';
    reason = 'Cambios de cursos de posgrado seguros (altas y/o bajas que reflejan la web).';
    if (bajasAnomaly) {
      decision = 'requires_review';
      reason = `Anomalía de seguridad: ${missingFromSource.length} bajas frente a ${scraper.active_count} activos. No se borra masivamente sin revisión.`;
    }
    const review = classifications.filter((c) => c.decision === 'requires_review');
    if (review.length > 0) {
      decision = 'requires_review';
      reason = `Requieren revisión: ${review.map((r) => r.path).join(', ')}`;
    }
  }

  return finalize({
    ok: true,
    decision,
    reason,
    dry_run: dryRun,
    force,
    active_count: scraper.active_count,
    created_docs: createdDocs,
    removed_docs: removedDocs,
    existing_docs_count: existingCourses.length,
    added_index_entries: addedIndexEntries.map((e) => e.path),
    date_drift: dateDrift,
    missing_from_source: missingFromSource,
    classifications,
    today,
  }, { prBodyPath, reportOutPath });
}

function buildPrBody(r) {
  const L = [];
  L.push('## Propuesta automática — cursos de posgrado');
  L.push('');
  L.push(`- **Decisión**: \`${r.decision}\``);
  L.push(`- **Motivo**: ${r.reason}`);
  L.push(`- **Fuente**: https://www.fce.unl.edu.ar/cursos_posgrado/index.php?act=showCursos`);
  L.push(`- **Fecha**: ${r.today}`);
  if (typeof r.active_count === 'number') L.push(`- **Cursos activos detectados**: ${r.active_count}`);
  if (r.created_docs?.length) {
    L.push('');
    L.push('### Cursos nuevos agregados');
    for (const p of r.created_docs) L.push(`- \`${p}\``);
  }
  if (r.date_drift?.length) {
    L.push('');
    L.push('### Fechas de inicio cambiadas en la fuente (revisar fichas existentes)');
    for (const d of r.date_drift) L.push(`- \`${d.path}\` → inicio en fuente: ${d.listing_start}`);
  }
  if (r.removed_docs?.length) {
    L.push('');
    L.push('### Cursos eliminados (bajas: ya no están en la web)');
    for (const p of r.removed_docs) L.push(`- \`${p}\``);
  } else if (r.missing_from_source?.length) {
    L.push('');
    L.push('### Cursos en el KB que ya no figuran activos (no eliminados por la guarda de anomalía)');
    for (const m of r.missing_from_source) L.push(`- \`${m.path}\` — ${m.title}`);
  }
  L.push('');
  L.push('> Las fichas de cursos ya existentes NO se sobrescriben (se preserva el contenido curado). Las bajas (cursos que salieron de la web) se eliminan para mantener el KB igual a la web. Datos personales (DNIs) saneados automáticamente.');
  return L.join('\n');
}

async function finalize(result, { prBodyPath, reportOutPath }) {
  result.pr_summary = buildPrBody(result);
  if (prBodyPath) await writeFile(prBodyPath, result.pr_summary, 'utf8');
  if (reportOutPath) await writeFile(reportOutPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '../..' },
      'state-dir': { type: 'string', default: DEFAULT_STATE_DIR },
      'pr-body': { type: 'string' },
      'report-out': { type: 'string' },
      'force': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const result = await proposePosgradoCoursesUpdate({
    kbRoot: resolve(here, values['kb-root']),
    stateDir: resolve(here, values['state-dir']),
    force: values.force,
    dryRun: values['dry-run'],
    prBodyPath: values['pr-body'] ? resolve(values['pr-body']) : null,
    reportOutPath: values['report-out'] ? resolve(values['report-out']) : null,
  });
  console.log(JSON.stringify({ decision: result.decision, reason: result.reason, created: result.created_docs, missing: result.missing_from_source }, null, 2));
}
