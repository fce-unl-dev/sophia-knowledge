import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateIndex } from '../validate_index.mjs';

// Arma un kbRoot temporal con un único item, su .md, indice.json y
// routing_metadata.json apuntando al sector dado. Devuelve el resultado de
// validateIndex para inspeccionar errors.
async function validateWithSector(sector, { path = 'academica/foo.md' } = {}) {
  const kbRoot = await mkdtemp(join(tmpdir(), 'kb-validate-'));
  const dir = join(kbRoot, path.split('/')[0]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(kbRoot, path), '# Foo\ncontenido\n', 'utf8');

  const indice = {
    version: 1,
    lastUpdated: '2026-05-29',
    items: [{ path, title: 'Foo', category: 'general' }],
  };
  await writeFile(join(kbRoot, 'indice.json'), JSON.stringify(indice), 'utf8');

  const routing = { mappings: { [path]: { sector } } };
  await writeFile(join(kbRoot, 'routing_metadata.json'), JSON.stringify(routing), 'utf8');

  const result = await validateIndex({ kbRoot });
  await rm(kbRoot, { recursive: true, force: true });
  return result;
}

describe('validate_index — sector de ruteo', () => {
  test('acepta un sector web presente en la taxonomía (academica)', async () => {
    const { errors } = await validateWithSector('academica');
    assert.deepEqual(
      errors.filter((e) => /sector de ruteo inválido/.test(e)),
      [],
    );
  });

  test('acepta los 10 sectores canónicos de la taxonomía', async () => {
    const sectors = [
      'academica', 'institucional', 'ciencia', 'extension', 'internacionales',
      'docentes', 'posgrados_graduados', 'posgrados_cursos_sin_titulo', 'grado', 'tramites_bedelia',
    ];
    for (const sector of sectors) {
      const { errors } = await validateWithSector(sector);
      assert.deepEqual(
        errors.filter((e) => /sector de ruteo inválido/.test(e)),
        [],
        `el sector '${sector}' no debería ser inválido`,
      );
    }
  });

  test('rechaza un sector que no está en la taxonomía', async () => {
    const { errors } = await validateWithSector('sector_inventado_xyz');
    assert.ok(
      errors.some((e) => /sector de ruteo inválido: 'sector_inventado_xyz'/.test(e)),
      'debería reportar el sector inventado como inválido',
    );
  });

  test('tolera sectores sin carpeta propia', async () => {
    // `normativa` agrupa resoluciones y reglamentos que viven en `complementos/`,
    // así que su kbFolder es null. Ese null llegaba a join(kbRoot, dir) y mataba
    // el validador entero con ERR_INVALID_ARG_TYPE — no un error de validación,
    // un crash. Rompió el CI del repo en dos commits seguidos (ago-2026).
    const { errors } = await validateWithSector('normativa');
    assert.deepEqual(
      errors.filter((e) => /sector de ruteo inválido/.test(e)),
      [],
      'normativa es un sector válido de la taxonomía',
    );
  });
});
