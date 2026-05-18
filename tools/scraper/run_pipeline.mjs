// Orquestador: compone scrape → generate → validate → classify para UN slug.
// No toca git. Devuelve un report JSON con la decisión final que el workflow
// (o el operador local) usa para ejecutar las git ops.
//
// Uso CLI:
//   node run_pipeline.mjs --slug=mba [--mode=refresh|force|dry-run] [--out=state/] [--source=sources.json] [--kb-root=..]
//
// Env requerido para que llegue a generate: GEMINI_API_KEY.
//
// Modos:
//   refresh  → diff-first. Si scrape devuelve unchanged, salta generate/validate/classify.
//   force    → ignora hash anterior y procesa siempre.
//   dry-run  → igual a refresh pero el report incluye dry_run: true (workflow lo respeta).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runForSource } from './scrape.mjs';
import { generateForSource } from './generate_md.mjs';
import { validate } from './validate.mjs';
import { classifyDiff } from './classify_diff.mjs';

export async function runPipelineForSource(source, {
  sourcesData,
  stateDir,
  kbRoot,
  apiKey,
  mode = 'refresh',
  today = new Date().toISOString().slice(0, 10),
  model,
  fetchImpl = fetch,
} = {}) {
  const report = { slug: source.slug, mode, steps: {} };

  // 1) scrape
  if (source.strategy === 'TBD') {
    report.decision = 'skipped';
    report.reason = 'strategy=TBD';
    return report;
  }
  try {
    const scrapeResult = await runForSource(source, { stateDir, fetchImpl });
    report.steps.scrape = scrapeResult;
    if (scrapeResult.status === 'unchanged' && mode !== 'force') {
      report.decision = 'no_change';
      report.reason = 'scrape_unchanged';
      return report;
    }
  } catch (err) {
    report.decision = 'error';
    report.error = `scrape: ${err.message || err}`;
    return report;
  }

  // 2) generate
  try {
    const genResult = await generateForSource(source, {
      sourcesData, stateDir, kbRoot, apiKey, today, model, fetchImpl,
    });
    report.steps.generate = genResult;
    if (genResult.status !== 'generated') {
      report.decision = 'error';
      report.error = `generate: status=${genResult.status} reason=${genResult.reason || 'unknown'}`;
      return report;
    }
  } catch (err) {
    report.decision = 'error';
    report.error = `generate: ${err.message || err}`;
    return report;
  }

  // 3) validate
  const candidatePath = join(stateDir, `${source.slug}.candidate.md`);
  const candidateMd = await readFile(candidatePath, 'utf8');
  const currentMdPath = join(kbRoot, source.indice_path);
  const currentMd = existsSync(currentMdPath) ? await readFile(currentMdPath, 'utf8') : '';

  try {
    const valResult = await validate(candidateMd, {
      currentMd,
      skipNetwork: false,
      fetchImpl,
    });
    report.steps.validate = valResult;
    if (!valResult.ok) {
      report.decision = 'rejected';
      report.reason = 'validation_failed';
      return report;
    }
  } catch (err) {
    report.decision = 'error';
    report.error = `validate: ${err.message || err}`;
    return report;
  }

  // 4) classify
  const sensitiveSections = sourcesData?.sensitive_sections || [];
  const classResult = classifyDiff(candidateMd, currentMd, { sensitiveSections });
  report.steps.classify = classResult;
  report.decision = classResult.decision;
  report.reason = classResult.reason;
  report.changed_sections = classResult.changed_sections;
  report.sensitive_changes = classResult.sensitive_changes;
  report.candidate_path = candidatePath;
  report.kb_path = source.indice_path;

  if (mode === 'dry-run') report.dry_run = true;
  return report;
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      mode: { type: 'string', default: 'refresh' },
      source: { type: 'string', default: 'sources.json' },
      out: { type: 'string', default: 'state' },
      'kb-root': { type: 'string', default: '../..' },
      model: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || !values.slug) {
    console.log(`Sophia KB pipeline orchestrator

Uso:
  node run_pipeline.mjs --slug=mba [--mode=refresh|force|dry-run]

Env: GEMINI_API_KEY
Output: JSON report a stdout con decision: no_change | auto_merge | requires_review | rejected | error | skipped.
`);
    process.exit(values.help ? 0 : 2);
  }

  const apiKey = process.env.GEMINI_API_KEY || '';
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = resolve(here, values.source);
  const stateDir = resolve(here, values.out);
  const kbRoot = resolve(here, values['kb-root']);

  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const source = (sourcesData.sources || []).find((s) => s.slug === values.slug);
  if (!source) {
    console.error(`Slug no encontrado: ${values.slug}`);
    process.exit(2);
  }

  const report = await runPipelineForSource(source, {
    sourcesData, stateDir, kbRoot, apiKey,
    mode: values.mode, model: values.model,
  });
  console.log(JSON.stringify(report, null, 2));

  // Exit code semantico: 0 si decision en {no_change, auto_merge, requires_review, skipped}, 1 si rejected/error
  const okDecisions = new Set(['no_change', 'auto_merge', 'requires_review', 'skipped']);
  process.exit(okDecisions.has(report.decision) ? 0 : 1);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
