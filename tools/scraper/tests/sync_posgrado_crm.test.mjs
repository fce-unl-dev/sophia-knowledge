import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPosgradoCrm } from '../sync_posgrado_crm.mjs';

const NOW = Date.parse('2026-10-06T15:00:00Z');
const COURSE = 'cursos-posgrado/test-course.md';
const CAREER = 'posgrados/test-career.md';
const SNAPSHOT = 'tools/scraper/posgrado_crm_snapshot.json';
const routes = { version: 1,
  basicos: { target: 'posgrado-general/datos-para-crawler.md', mode: 'deferred_until_equivalence_verified' },
  carreras: { 1271: [CAREER, 40] }, cursos: { 1415: COURSE } };

function item(kind, id, extra = {}) {
  return { id_posgrado: id, ...(kind === 'carreras' ? { id_carrera: 40 } : {}),
    tipo: kind === 'carreras' ? 'Posgrado' : 'Curso', subtipo: kind === 'carreras' ? 'Maestría' : null,
    nombre: `Propuesta ${id}`, url_sitio_web: 'https://fce.unl.edu.ar/posgrado',
    inscripcion: { estado: 'ABIERTA', esta_abierta: true, fecha_limite: '2026-11-01' },
    fecha_actualizacion: '2026-10-06 10:00:00', respuesta_frecuente: 'ARS 300.000', ...extra };
}

function feeds() {
  const envelope = (kind, records) => ({ schema_version: 1, origen: `fce_unl_${kind}_posgrado`,
    fecha_generacion: '2026-10-06 11:00:00', cantidad_registros: records.length, [kind]: records });
  return {
    basicos: { schema_version: 1, origen: 'fce_unl_faq_generales', faq_id: 423,
      fecha_generacion: '2026-10-06 11:00:00', fecha_actualizacion: '2026-10-06 10:00:00',
      secciones: [{ titulo: 'Contacto', contenido_completo: 'Email oficial', items: ['Email oficial'] }] },
    carreras: envelope('carreras', [item('carreras', 1271)]),
    cursos: envelope('cursos', [item('cursos', 1415)]),
  };
}

function fetcher(data) {
  return async url => {
    const kind = url.endsWith('doMostrarBasicos') ? 'basicos' :
      url.endsWith('doMostrarCarreras') ? 'carreras' : 'cursos';
    return new Response(typeof data[kind] === 'string' ? data[kind] : JSON.stringify(data[kind]));
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'crm-sync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['tools/scraper', 'cursos-posgrado', 'posgrados']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'indice.json'), JSON.stringify({ items: [{ path: COURSE }, { path: CAREER }] }));
  await writeFile(join(root, COURSE), '# Course\n\nAcademic detail.\n');
  await writeFile(join(root, CAREER), '# Career\n\nAcademic detail.\n');
  return root;
}

const run = (root, data, apply = false, overrides = {}) => syncPosgradoCrm({
  root, routes, now: NOW, fetchImpl: fetcher(data), apply, ...overrides,
});

test('default dry run is read-only; apply and repeated identical run are idempotent', async t => {
  const root = await setup(t);
  const data = feeds();
  const preview = await run(root, data);
  assert.equal(preview.status, 'dry_run');
  assert.equal(preview.snapshotChanged, true);
  assert.equal(preview.updates.length, 2);
  assert.equal(preview.deferred[0].kind, 'basicos');
  assert.equal((await readFile(join(root, COURSE), 'utf8')).includes('posgrado-crm:begin'), false);
  await assert.rejects(readFile(join(root, SNAPSHOT), 'utf8'), { code: 'ENOENT' });
  const applied = await run(root, data, true);
  assert.equal(applied.status, 'updated');
  assert.equal(applied.applied, true);
  const first = await readFile(join(root, COURSE), 'utf8');
  const snapshot = await readFile(join(root, SNAPSHOT), 'utf8');
  assert.match(first, /ARS 300\\\.000/);
  const again = await run(root, data, true);
  assert.equal(again.status, 'unchanged');
  assert.equal(await readFile(join(root, COURSE), 'utf8'), first);
  assert.equal(await readFile(join(root, SNAPSHOT), 'utf8'), snapshot);
});

test('routine revised price and deadline update without review; generation time alone does not', async t => {
  const root = await setup(t);
  const data = feeds();
  await run(root, data, true);
  data.cursos.cursos[0].respuesta_frecuente = 'ARS 350.000';
  data.cursos.cursos[0].inscripcion.fecha_limite = '2026-12-01';
  data.cursos.cursos[0].fecha_actualizacion = '2026-10-06 10:30:00';
  const result = await run(root, data, true);
  assert.equal(result.status, 'updated');
  assert.deepEqual(result.anomalies, []);
  assert.deepEqual(result.updates.map(update => update.path), [COURSE]);
  assert.match(await readFile(join(root, COURSE), 'utf8'), /ARS 350\\\.000/);
  data.cursos.fecha_generacion = '2026-10-06 11:01:00';
  const repeated = await run(root, data, true);
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.snapshotChanged, false);
});

test('timestamp regression, unchanged timestamp content change and malformed feed block all writes', async t => {
  const root = await setup(t);
  const data = feeds();
  await run(root, data, true);
  const original = await readFile(join(root, COURSE), 'utf8');
  const snapshot = await readFile(join(root, SNAPSHOT), 'utf8');
  data.cursos.cursos[0].fecha_actualizacion = '2026-10-06 09:00:00';
  let result = await run(root, data, true);
  assert.equal(result.status, 'needs_review');
  assert.ok(result.anomalies.some(issue => issue.code === 'timestamp_regression'));
  data.cursos.cursos[0].fecha_actualizacion = '2026-10-06 10:00:00';
  data.cursos.cursos[0].respuesta_frecuente = 'ARS 350.000';
  result = await run(root, data, true);
  assert.ok(result.anomalies.some(issue => issue.code === 'content_changed_without_revision'));
  data.cursos = '{invalid';
  result = await run(root, data, true);
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].code, 'invalid_json');
  assert.equal(await readFile(join(root, COURSE), 'utf8'), original);
  assert.equal(await readFile(join(root, SNAPSHOT), 'utf8'), snapshot);
});

test('unknown open ID and corrupt snapshot are fail closed', async t => {
  const root = await setup(t);
  const data = feeds();
  data.cursos.cursos.push(item('cursos', 999));
  data.cursos.cantidad_registros++;
  let result = await run(root, data, true);
  assert.equal(result.status, 'needs_review');
  assert.ok(result.anomalies.some(issue => issue.code === 'unknown_open_id'));
  await assert.rejects(readFile(join(root, SNAPSHOT), 'utf8'), { code: 'ENOENT' });
  await writeFile(join(root, SNAPSHOT), '{"schema_version":1,"records":[]}');
  result = await run(root, feeds(), true);
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].code, 'invalid_snapshot');
  assert.equal((await readFile(join(root, COURSE), 'utf8')).includes('posgrado-crm:begin'), false);
});

test('known quarantine leaves its document alone while other records can update', async t => {
  const root = await setup(t);
  const quarantinedRoutes = structuredClone(routes);
  quarantinedRoutes.quarantined = { 'cursos:1415': 'faq_start_date_conflicts_with_academic_pdf' };
  const result = await run(root, feeds(), true, { routes: quarantinedRoutes });
  assert.equal(result.status, 'updated');
  assert.deepEqual(result.updates.map(update => update.path), [CAREER]);
  assert.equal(result.quarantined[0].id, 'cursos:1415');
  assert.equal((await readFile(join(root, COURSE), 'utf8')).includes('posgrado-crm:begin'), false);
  const snapshot = JSON.parse(await readFile(join(root, SNAPSHOT), 'utf8'));
  assert.equal(snapshot.records.length, 3);
});

test('staging failure cannot partially modify documents or snapshot', async t => {
  const root = await setup(t);
  const missing = 'tools/scraper/no-such-directory/state.json';
  const result = await run(root, feeds(), true, { snapshotPath: missing });
  assert.equal(result.status, 'error');
  assert.equal((await readFile(join(root, COURSE), 'utf8')).includes('posgrado-crm:begin'), false);
  assert.equal((await readFile(join(root, CAREER), 'utf8')).includes('posgrado-crm:begin'), false);
  assert.deepEqual((await readdir(join(root, 'cursos-posgrado'))).filter(name => name.startsWith('.crm-sync-')), []);
});
