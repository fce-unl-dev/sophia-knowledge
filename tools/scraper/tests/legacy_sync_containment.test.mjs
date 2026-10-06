import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipelineForSource } from '../run_pipeline.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('generic sync excludes the CRM aggregate and postgraduate course catalog', async () => {
  const sources = JSON.parse(await readFile(join(repoRoot, 'tools/scraper/sources.json'), 'utf8'));
  const genericSlugs = sources.sources
    .filter((source) => source.strategy !== 'TBD' && source.strategy !== 'fce-wordpress-section')
    .map((source) => source.slug);

  assert.ok(!genericSlugs.includes('crawler'));
  assert.ok(!genericSlugs.includes('cursos-posgrado'));
  assert.ok(!sources.sources.some((source) => source.indice_path === 'posgrado-general/crawler.md'));

  const index = JSON.parse(await readFile(join(repoRoot, 'indice.json'), 'utf8'));
  const routing = JSON.parse(await readFile(join(repoRoot, 'routing_metadata.json'), 'utf8'));
  assert.ok(!index.items.some((item) => item.path === 'posgrado-general/crawler.md'));
  assert.ok(!Object.hasOwn(routing.mappings, 'posgrado-general/crawler.md'));

  const catalogWorkflow = await readFile(join(repoRoot, '.github/workflows/propose-posgrado-courses-kb.yml'), 'utf8');
  assert.match(catalogWorkflow, /node propose_posgrado_courses_update\.mjs/);
});

test('generic pipeline rejects a CRM overlay before scraping or classifying', async (t) => {
  const kbRoot = await mkdtemp(join(tmpdir(), 'sophia-overlay-'));
  t.after(() => rm(kbRoot, { recursive: true, force: true }));
  const source = {
    slug: 'sample',
    indice_path: 'sample.md',
    url: 'https://example.invalid/sample',
    strategy: 'wordpress-homepage',
  };
  let fetchCalls = 0;
  const staleCandidate = join(kbRoot, 'sample.candidate.md');
  await writeFile(staleCandidate, '# Stale candidate without CRM data\n');

  for (const overlay of [
    '<!-- posgrado-crm:begin -->\nCRM data\n<!-- posgrado-crm:end -->',
    '<!-- posgrado-crm:begin -->\nIncomplete CRM data',
    '<!-- posgrado-crm:end -->',
  ]) {
    await writeFile(join(kbRoot, source.indice_path), `# Existing\n\n${overlay}\n`);
    const report = await runPipelineForSource(source, {
      kbRoot,
      stateDir: kbRoot,
      sourcesData: { sensitive_sections: [] },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('should not fetch'); },
    });

    assert.equal(report.decision, 'rejected');
    assert.equal(report.reason, 'protected_crm_overlay');
    assert.equal(report.kb_path, source.indice_path);
    assert.deepEqual(report.steps, {});
    assert.equal(await readFile(staleCandidate, 'utf8'), '# Stale candidate without CRM data\n');
  }
  assert.equal(fetchCalls, 0);
});
