import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFreshnessReport } from '../check_freshness_report.mjs';
import { generateFreshnessReport, parseReferenceDate } from '../freshness_report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = await readFile(resolve(root, '.github/workflows/sync-posgrado-crm-kb.yml'), 'utf8');

test('official CRM workflow normalizes canonical freshness before gates and scopes its publication', () => {
  const normalize = workflow.indexOf('- name: Refresh canonical freshness after CRM updates');
  const validation = workflow.indexOf('- name: Run complete KB validation');
  assert.ok(normalize > 0 && normalize < validation, 'freshness normalization must precede validation');
  const block = workflow.slice(normalize, validation);
  assert.match(block, /if: steps\.sync\.outputs\.status == 'updated'/);
  assert.match(block, /freshness_report\.mjs --kb-root=\.\.\/\.\. --format=md --reference-date="\$reference_date" --out=freshness\.md/);
  assert.match(block, /Generado el/);
  assert.match(block, /git diff --quiet -- freshness\.md/);
  assert.match(workflow, /FRESHNESS_CHANGED: \$\{\{ steps\.freshness\.outputs\.changed \}\}/);
  assert.match(workflow, /if \[ "\$FRESHNESS_CHANGED" = true \]; then allowed\["freshness\.md"\]=1; fi/);
});

test('freshness workflow shell repairs a stale fixture without inventing review metadata', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'crm-workflow-freshness-'));
  try {
    const stateDir = resolve(fixture, 'tools/scraper/state');
    await mkdir(stateDir, { recursive: true });
    await mkdir(resolve(fixture, 'posgrados'));
    await copyFile(resolve(root, 'tools/scraper/freshness_report.mjs'),
      resolve(fixture, 'tools/scraper/freshness_report.mjs'));
    await writeFile(resolve(fixture, 'indice.json'), JSON.stringify({
      items: [{ path: 'posgrados/programa.md', title: 'Program', category: 'Posgrado' }],
    }));
    await writeFile(resolve(fixture, 'tools/scraper/sources.json'), JSON.stringify({ sources: [] }));
    const document = resolve(fixture, 'posgrados/programa.md');
    await writeFile(document, '# Program\n');
    await writeFile(resolve(fixture, 'freshness.md'), await generateFreshnessReport({
      kbRoot: fixture, stateDir, format: 'md', today: parseReferenceDate('2026-10-02'),
    }));
    const content = '# Program\n**Última revisión humana**: PENDIENTE — requiere revisión editorial.\n';
    // Introduce another canonical item, as a source sync can do before the CRM run.
    await writeFile(document, content);
    await writeFile(resolve(fixture, 'indice.json'), JSON.stringify({ items: [
      { path: 'posgrados/programa.md', title: 'Program', category: 'Posgrado' },
      { path: 'posgrados/otro.md', title: 'Other', category: 'Posgrado' },
    ] }));
    await writeFile(resolve(fixture, 'posgrados/otro.md'), '# Other\n');
    await assert.rejects(() => checkFreshnessReport({ kbRoot: fixture, stateDir }), /desactualizado/);
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['add', 'freshness.md'], { cwd: fixture });
    const block = workflow.slice(workflow.indexOf('- name: Refresh canonical freshness after CRM updates'),
      workflow.indexOf('- name: Run complete KB validation'));
    const script = block.slice(block.indexOf('run: |') + 'run: |'.length)
      .split('\n').map(line => line.replace(/^          /, '')).join('\n');
    const output = resolve(fixture, 'output.txt');
    execFileSync('bash', ['-c', script], { cwd: fixture, env: { ...process.env, GITHUB_OUTPUT: output } });
    await checkFreshnessReport({ kbRoot: fixture, stateDir });
    assert.match(await readFile(output, 'utf8'), /changed=true/);
    assert.match(await readFile(resolve(fixture, 'freshness.md'), 'utf8'), /Generado el:\*\* 2026-10-02/);
    assert.equal(await readFile(document, 'utf8'), content);
    execFileSync('git', ['add', 'freshness.md'], { cwd: fixture });
    await writeFile(output, '');
    execFileSync('bash', ['-c', script], { cwd: fixture, env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.match(await readFile(output, 'utf8'), /changed=false/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('official CRM workflow schedules frequent serial runs and supports a safe preview', () => {
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /- dry-run/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /npm ci --prefix tools\/scraper/);
  assert.match(workflow, /sync_posgrado_crm\.mjs --apply/);
  assert.match(workflow, /sync_posgrado_crm\.mjs --dry-run/);
  assert.match(workflow, /\{ \[ "\$MODE" = apply \] && \[ "\$status" = dry_run \]; \} \|\|\s+\{ \[ "\$MODE" = dry-run \] && \[ "\$status" != dry_run \]; \}; then/);
  assert.match(workflow, /Unexpected CRM sync status '\$status' for mode '\$MODE'.*GITHUB_STEP_SUMMARY/);
});

test('official CRM workflow fails closed before publishing and never reuses a sync branch', () => {
  const gates = ['npm test --prefix tools/scraper', 'node --check "$file"',
    'validate_index.mjs', 'validate_links.mjs', 'check_freshness_report.mjs',
    'git diff --check'];
  const publish = workflow.indexOf('git commit -m');
  assert.ok(publish > 0);
  for (const gate of gates) assert.ok(workflow.indexOf(gate) < publish, `${gate} must precede commit`);
  assert.match(workflow, /\[ "\$exit_code" -ne 0 \] \|\| \[ "\$status" = error \] \|\| \[ "\$status" = needs_review \]/);
  assert.match(workflow, /if: steps\.sync\.outputs\.status == 'updated'/);
  assert.match(workflow, /startsWith\("kb-crm\/official-json-"\)/i);
  assert.match(workflow, /git diff --name-only -z; git ls-files --others --exclude-standard -z/);
  assert.match(workflow, /git add -- "\$path"/);
  assert.match(workflow, /kb-crm\/official-json-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.doesNotMatch(workflow, /git push -f|git push --force|kb-sync\//);
  assert.doesNotMatch(workflow, /needs-review|mark-as-reviewed|\|\| echo/);
  assert.match(workflow, /gh pr merge "\$pr" --squash --delete-branch/);
});
