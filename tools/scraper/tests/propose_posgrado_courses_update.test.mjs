import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crmRoutes from '../posgrado_crm_routes.json' with { type: 'json' };
import { proposePosgradoCoursesUpdate } from '../propose_posgrado_courses_update.mjs';

test('the legacy course listing cannot remove closed CRM courses but still removes eligible non-CRM courses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'posgrado-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'cursos-posgrado'));

  const crmPath = crmRoutes.cursos['1417'];
  const legacyPath = 'cursos-posgrado/legacy-course.md';
  const activePath = 'cursos-posgrado/curso-activo.md';
  const entries = [crmPath, legacyPath, activePath]
    .map(path => ({ path, title: path, category: 'Curso de posgrado' }));
  await writeFile(join(root, 'indice.json'), JSON.stringify({ version: 1, items: entries }));
  const expired = '# Curso\n\n- **Fecha de inicio publicada**: 01/06/2025\n';
  await writeFile(join(root, crmPath), expired);
  await writeFile(join(root, legacyPath), expired);
  await writeFile(join(root, activePath), '# Curso activo\n');

  const html = `<div class='curso'><p><b>CURSO ACTIVO</b></p>
    Inicio:<b>01/11/2026</b>
    <a href='https://fce.unl.edu.ar/posgrados/index.php?act=showLogin&id_posgrado=999'>PRE-INSCRIPCIÓN</a>
    </div></div>`;
  const result = await proposePosgradoCoursesUpdate({
    kbRoot: root,
    stateDir: join(root, 'state'),
    today: '2026-10-06',
    dryRun: true,
    fetchImpl: async () => new Response(html),
  });

  assert.equal(result.decision, 'auto_merge');
  assert.deepEqual(result.missing_from_source.map(item => item.path), [legacyPath]);
  assert.deepEqual(result.removed_docs, [legacyPath]);
  assert.ok(!result.missing_from_source.some(item => item.path === crmPath));
  assert.equal(await readFile(join(root, crmPath), 'utf8'), expired);
  assert.equal(await readFile(join(root, legacyPath), 'utf8'), expired, 'dry-run does not mutate files');
});
