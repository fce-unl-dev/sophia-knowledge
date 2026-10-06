// Official CRM JSON synchronization. Dry-run is the default; no HTML fallback.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import routesDefault from './posgrado_crm_routes.json' with { type: 'json' };
import { parsePosgradoFeed, compareFeedSnapshots } from './posgrado_json_contract.mjs';
import { planPosgradoCrmUpdates } from './plan_posgrado_crm_updates.mjs';

const KINDS = ['basicos', 'carreras', 'cursos'];
const ENDPOINT = 'https://fce.unl.edu.ar/posgradosCRM/index.php?act=DatosParaCrawler.';
const ACTION = { basicos: 'doMostrarBasicos', carreras: 'doMostrarCarreras', cursos: 'doMostrarCursos' };
const SNAPSHOT = 'tools/scraper/posgrado_crm_snapshot.json';
const MAX_BYTES = 4 * 1024 * 1024;

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

async function fetchRaw(kind, fetchImpl) {
  const response = await fetchImpl(`${ENDPOINT}${ACTION[kind]}`, {
    signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' },
  });
  if (!response.ok || !response.body) fail('feed_unavailable', `${kind}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) fail('feed_too_large', kind);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function snapshotOf(parsed) {
  return { schema_version: 1, records: KINDS.flatMap(kind => parsed[kind].records.map(record => ({
    kind, id: record.id, updatedAtMs: record.updatedAtMs, contentHash: record.contentHash,
  }))).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) };
}

function validateSnapshot(snapshot) {
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.records)) fail('invalid_snapshot', 'schema');
  const seen = new Set();
  for (const record of snapshot.records) {
    if (!KINDS.includes(record?.kind) || typeof record.id !== 'string' ||
        !new RegExp(`^${record.kind}:[1-9]\\d*$`).test(record.id) || seen.has(record.id) ||
        !Number.isSafeInteger(record.updatedAtMs) || record.updatedAtMs < 0 ||
        !/^[a-f0-9]{64}$/.test(record.contentHash)) fail('invalid_snapshot', 'record');
    seen.add(record.id);
  }
  if (KINDS.some(kind => !snapshot.records.some(record => record.kind === kind))) {
    fail('invalid_snapshot', 'missing kind');
  }
  return snapshot;
}

function compareSnapshots(previous, current) {
  if (!previous) return [];
  return KINDS.flatMap(kind => compareFeedSnapshots(
    { kind, records: previous.records.filter(record => record.kind === kind) },
    { kind, records: current.records.filter(record => record.kind === kind) },
  ));
}

async function commitFiles(root, changes) {
  const staged = [];
  const completed = [];
  try {
    for (const change of changes) {
      const target = join(root, change.path);
      const temp = join(dirname(target), `.crm-sync-${randomUUID()}.tmp`);
      await writeFile(temp, change.content, { flag: 'wx' });
      staged.push(temp);
    }
    for (let i = 0; i < changes.length; i++) {
      await rename(staged[i], join(root, changes[i].path));
      completed.push(changes[i]);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of completed.reverse()) {
      try {
        if (change.before === null) await unlink(join(root, change.path));
        else await writeFile(join(root, change.path), change.before);
      } catch (rollbackError) { rollbackErrors.push(`${change.path}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) fail('rollback_failed', rollbackErrors.join('; '));
    throw error;
  } finally { await Promise.all(staged.map(path => unlink(path).catch(() => {}))); }
}

/** Returns a machine-readable report; never mutates unless apply is explicitly true. */
export async function syncPosgradoCrm({ root, apply = false, fetchImpl = fetch, now = Date.now(),
  routes = routesDefault, snapshotPath = SNAPSHOT } = {}) {
  if (!root) throw new TypeError('root is required');
  root = resolve(root);
  const report = { status: 'error', applied: false, updates: [], quarantined: [], skipped: [],
    deferred: [], anomalies: [], errors: [], snapshotChanged: false, snapshotOnly: false };
  try {
    const rawFeeds = Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind,
      await fetchRaw(kind, fetchImpl)])));
    const parsed = Object.fromEntries(KINDS.map(kind => [kind,
      parsePosgradoFeed(kind, rawFeeds[kind], { now })]));
    const nextSnapshot = snapshotOf(parsed);
    let oldSnapshotText = null;
    try { oldSnapshotText = await readFile(join(root, snapshotPath), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const oldSnapshot = oldSnapshotText === null ? null : validateSnapshot(JSON.parse(oldSnapshotText));
    report.anomalies.push(...compareSnapshots(oldSnapshot, nextSnapshot));
    const index = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
    const paths = new Set([...Object.values(routes.carreras ?? {}).map(target => target?.[0]),
      ...Object.values(routes.cursos ?? {})]);
    const documents = Object.fromEntries(await Promise.all([...paths].map(async path =>
      [path, await readFile(join(root, path), 'utf8')])));
    const plan = planPosgradoCrmUpdates({ rawFeeds, index, documents, routes, now });
    report.anomalies.push(...plan.anomalies);
    report.quarantined = plan.quarantined;
    report.skipped = plan.skipped;
    report.deferred = plan.deferred;
    report.updates = plan.updates.map(update => ({ path: update.path, ids: update.ids }));
    report.snapshotChanged = JSON.stringify(oldSnapshot) !== JSON.stringify(nextSnapshot);
    report.snapshotOnly = report.snapshotChanged && report.updates.length === 0;
    if (report.anomalies.length) { report.status = 'needs_review'; report.updates = []; return report; }
    if (!apply) { report.status = 'dry_run'; return report; }
    const changes = plan.updates.map(update => ({ ...update, before: documents[update.path] }));
    if (report.snapshotChanged) changes.push({ path: snapshotPath,
      content: `${JSON.stringify(nextSnapshot, null, 2)}\n`, before: oldSnapshotText });
    if (changes.length) await commitFiles(root, changes);
    report.applied = changes.length > 0;
    report.status = changes.length ? 'updated' : 'unchanged';
  } catch (error) { report.errors.push({ code: error.code ?? 'sync_failed', message: error.message }); }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--apply', '--dry-run', '--kb-root']);
  const rootFlag = args.indexOf('--kb-root');
  const root = rootFlag < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : args[rootFlag + 1];
  const flags = args.filter((arg, i) => i !== rootFlag && i !== rootFlag + 1);
  if (!root || flags.some(flag => !allowed.has(flag)) || flags.includes('--apply') && flags.includes('--dry-run')) {
    console.error(JSON.stringify({ status: 'error', errors: [{ code: 'invalid_arguments' }] }));
    process.exitCode = 2;
  } else {
    const report = await syncPosgradoCrm({ root, apply: flags.includes('--apply') });
    console.log(JSON.stringify(report));
    if (report.status === 'error' || report.status === 'needs_review') process.exitCode = 1;
  }
}
