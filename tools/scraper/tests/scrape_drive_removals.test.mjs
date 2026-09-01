import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  DRIVE_REMOVAL_SET_VERSION,
  consumeDriveRemovalConfirmation,
  createDriveRemovalConfirmation,
  createDriveRemovalIdentity,
  driveRemovalConfirmationContinuation,
  validateDriveRemovalConfirmation,
} from '../scrape_drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function stateWith(ids, removalIds = []) {
  return {
    files: Object.fromEntries(ids.map((id) => [id, {
      id,
      path: `Drive/${id}.pdf`,
      slug: `drive-${id}`,
      status: removalIds.includes(id) ? 'deleted' : 'synchronized',
    }])),
  };
}

async function assertApplyRejectedWithoutWrites(state) {
  const root = await mkdtemp(join(tmpdir(), 'sophia-drive-apply-'));
  const stateDir = join(root, 'state');
  const kbRoot = join(root, 'kb');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(kbRoot, 'complementos'), { recursive: true });
  const index = { version: 7, items: [
    { path: 'complementos/drive-c.md', title: 'C' },
    { path: 'complementos/drive-d.md', title: 'D' },
  ] };
  await writeFile(join(stateDir, 'drive.meta.json'), JSON.stringify(state, null, 2) + '\n');
  await writeFile(join(kbRoot, 'indice.json'), JSON.stringify(index, null, 2) + '\n');
  await writeFile(join(kbRoot, 'complementos/drive-c.md'), '# C\n');
  await writeFile(join(kbRoot, 'complementos/drive-d.md'), '# D\n');
  const beforeState = await readFile(join(stateDir, 'drive.meta.json'), 'utf8');
  const beforeIndex = await readFile(join(kbRoot, 'indice.json'), 'utf8');

  const result = spawnSync(process.execPath, [
    join(here, '../scrape_drive.mjs'), '--apply', `--kb-root=${kbRoot}`, `--out=${stateDir}`,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bajas masivas.*rechazadas en apply/);
  assert.match(result.stderr, /digest sha256:/);
  assert.equal(await readFile(join(stateDir, 'drive.meta.json'), 'utf8'), beforeState);
  assert.equal(await readFile(join(kbRoot, 'indice.json'), 'utf8'), beforeIndex);
  assert.equal(await readFile(join(kbRoot, 'complementos/drive-c.md'), 'utf8'), '# C\n');
  assert.equal(await readFile(join(kbRoot, 'complementos/drive-d.md'), 'utf8'), '# D\n');
}

describe('Drive massive-removal confirmation', () => {
  test('derives the expected canonical identity for the current 31/15 set', async () => {
    const current = JSON.parse(await readFile(join(here, '../state/complementos/drive.meta.json'), 'utf8'));
    const removalIds = current.removal_anomaly.removal_ids;
    const identity = createDriveRemovalIdentity(Object.keys(current.files), removalIds);

    assert.equal(identity.version, DRIVE_REMOVAL_SET_VERSION);
    assert.equal(identity.inventory_ids.length, 31);
    assert.equal(identity.removal_ids.length, 15);
    assert.equal(identity.digest, 'sha256:dd3983c532799f320d0397ff399dcba27ae0afba20562c49ad0826ab231d4e75');
    assert.equal(validateDriveRemovalConfirmation(current, removalIds).authorized, true);
  });

  test('rejects a missing, stale or incomplete confirmation', () => {
    const state = stateWith(['b', 'a', 'c', 'd'], ['c', 'd']);
    const missing = validateDriveRemovalConfirmation(state, ['c', 'd']);
    assert.equal(missing.authorized, false);
    assert.match(missing.reason, /Falta/);

    state.removal_confirmation = {
      version: DRIVE_REMOVAL_SET_VERSION,
      digest: createDriveRemovalIdentity(['a', 'b', 'c'], ['c']).digest,
      actor: 'operator',
      reason: 'Verified',
      confirmed_at: '2026-08-31T00:00:00.000Z',
    };
    const stale = validateDriveRemovalConfirmation(state, ['c', 'd']);
    assert.equal(stale.authorized, false);
    assert.match(stale.reason, /obsoleta|otro conjunto/);

    state.removal_confirmation = {
      version: missing.identity.version,
      digest: missing.identity.digest,
      actor: '',
      reason: 'Verified',
      confirmed_at: '2026-08-31T00:00:00.000Z',
    };
    const incomplete = validateDriveRemovalConfirmation(state, ['c', 'd']);
    assert.equal(incomplete.authorized, false);
    assert.match(incomplete.reason, /actor, motivo y fecha/);
  });

  test('prepares a confirmation only from an anomaly bound to the current state', () => {
    const state = stateWith(['d', 'b', 'a', 'c']);
    const identity = createDriveRemovalIdentity(Object.keys(state.files), ['d', 'c']);
    state.removal_anomaly = {
      version: identity.version,
      digest: identity.digest,
      inventory_ids: identity.inventory_ids,
      removal_ids: identity.removal_ids,
    };

    const confirmation = createDriveRemovalConfirmation(state, {
      actor: 'berna',
      reason: 'Equivalent content is available from the official website.',
      confirmedAt: '2026-08-31T00:00:00.000Z',
    });
    assert.deepEqual(confirmation, {
      version: identity.version,
      digest: identity.digest,
      actor: 'berna',
      reason: 'Equivalent content is available from the official website.',
      confirmed_at: '2026-08-31T00:00:00.000Z',
    });

    state.removal_anomaly.digest = 'sha256:forged';
    assert.throws(() => createDriveRemovalConfirmation(state, {
      actor: 'berna', reason: 'Verified',
    }), /no coincide con el inventario/);
  });

  test('printed and workflow continuation start from the anomaly-bearing bot branch', async () => {
    const identity = createDriveRemovalIdentity(['a', 'b', 'c', 'd'], ['c', 'd']);
    const commands = driveRemovalConfirmationContinuation(identity);
    assert.equal(commands[0], 'git fetch origin kb-sync/update-drive');
    assert.match(commands[1], /^git switch -c chore\/confirm-drive-removal-[a-f0-9]{12} --track origin\/kb-sync\/update-drive$/);
    assert.ok(commands.indexOf('cd tools/scraper') < commands.findIndex((line) => line.includes('--confirm-removals')));

    const workflow = await readFile(join(here, '../../../.github/workflows/ingest-drive.yml'), 'utf8');
    assert.match(workflow, /git fetch origin kb-sync\/update-drive/);
    assert.match(workflow, /--track origin\/kb-sync\/update-drive/);
  });

  test('consumes an exact confirmation into inert audit evidence', () => {
    const state = stateWith(['a', 'b', 'c', 'd'], ['c', 'd']);
    const identity = createDriveRemovalIdentity(Object.keys(state.files), ['c', 'd']);
    state.removal_confirmation = {
      version: identity.version,
      digest: identity.digest,
      actor: 'berna',
      reason: 'Verified duplicate sources.',
      confirmed_at: '2026-08-31T00:00:00.000Z',
    };
    state.removal_anomaly = {
      version: identity.version,
      digest: identity.digest,
      inventory_ids: identity.inventory_ids,
      removal_ids: ['c', 'd'],
    };
    const validation = validateDriveRemovalConfirmation(state, ['c', 'd']);

    consumeDriveRemovalConfirmation(
      state,
      validation,
      [state.files.c, state.files.d],
      '2026-09-01T00:00:00.000Z',
    );

    assert.equal(state.removal_confirmation, undefined);
    assert.equal(state.removal_anomaly, undefined);
    assert.equal(state.last_confirmed_removal.digest, identity.digest);
    assert.deepEqual(state.last_confirmed_removal.removal_ids, ['c', 'd']);
    assert.equal(validateDriveRemovalConfirmation(state, ['c', 'd']).authorized, false,
      'last_confirmed_removal must never authorize replay');
  });

  test('apply rejects forged massive deleted state before changing KB bytes', async () => {
    await assertApplyRejectedWithoutWrites(stateWith(['a', 'b', 'c', 'd'], ['c', 'd']));
  });

  test('apply rejects a confirmed anomaly when the current inventory was added to or replaced', async () => {
    const identity = createDriveRemovalIdentity(['a', 'b', 'c', 'd'], ['c', 'd']);
    for (const currentIds of [
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'x', 'c', 'd'],
    ]) {
      const state = stateWith(currentIds, ['c', 'd']);
      state.removal_anomaly = {
        version: identity.version,
        digest: identity.digest,
        inventory_ids: identity.inventory_ids,
        removal_ids: identity.removal_ids,
      };
      state.removal_confirmation = {
        version: identity.version,
        digest: identity.digest,
        actor: 'berna',
        reason: 'Verified for the previous inventory.',
        confirmed_at: '2026-08-31T00:00:00.000Z',
      };
      await assertApplyRejectedWithoutWrites(state);
    }
  });

  test('apply consumes an exact confirmation and removes all bound content and index references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sophia-drive-confirmed-'));
    const sourceScraper = join(here, '..');
    const scraperDir = join(root, 'tools/scraper');
    const stateDir = join(scraperDir, 'state/complementos');
    await mkdir(join(root, 'tools'), { recursive: true });
    await cp(sourceScraper, scraperDir, {
      recursive: true,
      filter: (source) => !source.endsWith('/node_modules'),
    });
    await symlink(join(sourceScraper, 'node_modules'), join(scraperDir, 'node_modules'));
    await mkdir(join(root, 'complementos'), { recursive: true });

    const state = stateWith(['a', 'b', 'c', 'd'], ['c', 'd']);
    const identity = createDriveRemovalIdentity(Object.keys(state.files), ['c', 'd']);
    state.removal_anomaly = {
      version: identity.version,
      digest: identity.digest,
      inventory_ids: identity.inventory_ids,
      removal_ids: identity.removal_ids,
      removals: 2,
    };
    state.removal_confirmation = {
      version: identity.version,
      digest: identity.digest,
      actor: 'berna',
      reason: 'Equivalent official website sources were verified.',
      confirmed_at: '2026-08-31T00:00:00.000Z',
    };
    const index = { version: 7, items: [
      { path: 'complementos/drive-c.md', title: 'C', category: 'Complementario' },
      { path: 'complementos/drive-d.md', title: 'D', category: 'Complementario' },
    ] };
    await writeFile(join(stateDir, 'drive.meta.json'), JSON.stringify(state, null, 2) + '\n');
    await writeFile(join(root, 'indice.json'), JSON.stringify(index, null, 2) + '\n');
    await writeFile(join(root, 'complementos/drive-c.md'), '# C\n');
    await writeFile(join(root, 'complementos/drive-d.md'), '# D\n');

    const scriptPath = await realpath(join(scraperDir, 'scrape_drive.mjs'));
    const realRoot = await realpath(root);
    const realStateDir = await realpath(stateDir);
    const result = spawnSync(process.execPath, [
      scriptPath, '--apply', `--kb-root=${realRoot}`, `--out=${realStateDir}`,
    ], { cwd: scraperDir, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(join(root, 'complementos/drive-c.md')));
    await assert.rejects(access(join(root, 'complementos/drive-d.md')));
    const appliedIndex = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
    assert.deepEqual(appliedIndex.items, []);
    const appliedState = JSON.parse(await readFile(join(stateDir, 'drive.meta.json'), 'utf8'));
    assert.deepEqual(Object.keys(appliedState.files).sort(), ['a', 'b']);
    assert.equal(appliedState.removal_confirmation, undefined);
    assert.equal(appliedState.removal_anomaly, undefined);
    assert.equal(appliedState.last_confirmed_removal.digest, identity.digest);
    assert.deepEqual(appliedState.last_confirmed_removal.removal_ids, ['c', 'd']);
    assert.ok(await readFile(join(root, 'routing_metadata.json'), 'utf8'));
  });
});
