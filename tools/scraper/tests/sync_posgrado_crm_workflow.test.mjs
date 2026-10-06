import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = await readFile(resolve(root, '.github/workflows/sync-posgrado-crm-kb.yml'), 'utf8');

test('official CRM workflow schedules frequent serial runs and supports a safe preview', () => {
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /- dry-run/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /npm ci --prefix tools\/scraper/);
  assert.match(workflow, /sync_posgrado_crm\.mjs --apply/);
  assert.match(workflow, /sync_posgrado_crm\.mjs --dry-run/);
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
