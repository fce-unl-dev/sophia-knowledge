// Guarda contra colisión de ramas entre pipelines del KB.
//
// sync-kb.yml arma una rama por cada source de sources.json con el patrón
// "kb-sync/update-${slug}", pushea con -f y auto-mergea cuando la decisión es
// auto_merge. Los workflows propose-*/ingest-* hardcodean su propia rama y
// también pushean con -f.
//
// Si dos pipelines comparten rama, el que corre segundo pisa el contenido del
// primero sin dejar rastro, y el PR abierto por uno puede terminar mergeado con
// el contenido del otro. Pasó con "kb-sync/update-cursos-posgrado": cuatro
// semanas de fichas de cursos de posgrado destruidas antes de que nadie las
// revisara, con todos los runs en verde.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const workflowsDir = join(repoRoot, '.github/workflows');

// Extrae las asignaciones `branch="..."` de un workflow. Se queda solo con las
// literales: una rama construida con variables la cubre el chequeo de patrón.
function extractBranchLiterals(yaml) {
  return [...yaml.matchAll(/^\s*branch="([^"$]+)"\s*$/gm)].map((m) => m[1]);
}

async function loadWorkflowBranches() {
  const files = (await readdir(workflowsDir)).filter((f) => f.endsWith('.yml'));
  const byFile = new Map();
  for (const file of files) {
    const yaml = await readFile(join(workflowsDir, file), 'utf8');
    const branches = extractBranchLiterals(yaml);
    if (branches.length > 0) byFile.set(file, branches);
  }
  return byFile;
}

async function loadGenericSyncBranches() {
  const sources = JSON.parse(await readFile(join(repoRoot, 'tools/scraper/sources.json'), 'utf8'));
  // Mismo filtro que el paso "Compute slug matrix" de sync-kb.yml.
  return (sources.sources || [])
    .filter((s) => s.strategy !== 'TBD' && s.strategy !== 'fce-wordpress-section')
    .map((s) => ({ slug: s.slug, branch: `kb-sync/update-${s.slug}` }));
}

describe('ramas de los workflows del KB', () => {
  test('ningún workflow dedicado usa una rama del sync genérico', async () => {
    const byFile = await loadWorkflowBranches();
    const generic = await loadGenericSyncBranches();
    const genericBranches = new Map(generic.map((g) => [g.branch, g.slug]));

    const collisions = [];
    for (const [file, branches] of byFile) {
      if (file === 'sync-kb.yml') continue;
      for (const branch of branches) {
        if (genericBranches.has(branch)) {
          collisions.push(`${file} usa "${branch}", que sync-kb.yml también genera para el slug "${genericBranches.get(branch)}"`);
        }
      }
    }

    assert.deepEqual(
      collisions,
      [],
      `Colisión de ramas: los dos pipelines pushean con -f y se pisan mutuamente.\n${collisions.join('\n')}`,
    );
  });

  test('dos workflows dedicados no comparten rama entre sí', async () => {
    const byFile = await loadWorkflowBranches();
    const seen = new Map();
    const collisions = [];
    for (const [file, branches] of byFile) {
      if (file === 'sync-kb.yml') continue;
      for (const branch of branches) {
        if (seen.has(branch)) collisions.push(`${seen.get(branch)} y ${file} comparten "${branch}"`);
        else seen.set(branch, file);
      }
    }
    assert.deepEqual(collisions, [], collisions.join('\n'));
  });

  test('el workflow de cursos de posgrado sigue teniendo rama propia', async () => {
    const yaml = await readFile(join(workflowsDir, 'propose-posgrado-courses-kb.yml'), 'utf8');
    const branches = extractBranchLiterals(yaml);
    assert.ok(branches.length > 0, 'no se encontró ninguna rama literal en el workflow');
    assert.ok(
      !branches.includes('kb-sync/update-cursos-posgrado'),
      'la rama volvió a colisionar con la del source "cursos-posgrado" del sync genérico',
    );
  });
});
