// Documentos marcados como [PROVISORIO] en Drive.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyProvisionalNotice, isProvisional, PROVISIONAL_NOTICE, stripProvisionalTag } from '../provisional_notice.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('marca [PROVISORIO]', () => {
  test('se reconoce en cualquier posición y sin importar mayúsculas', () => {
    for (const name of ['[PROVISORIO] LA 484 Correlatividades.pdf', 'LA 484 Correlatividades [provisorio].pdf', 'LA 484 [ Provisorio ] Correlatividades.pdf']) {
      assert.equal(isProvisional({ name }), true, name);
    }
    assert.equal(isProvisional({ name: 'LA 484 Correlatividades.pdf' }), false);
    assert.equal(isProvisional({ name: 'Régimen provisorio de cursado.pdf' }), false, 'la palabra sola no alcanza: hace falta la marca');
  });

  test('quitar la marca no cambia el nombre base (mismo slug)', () => {
    const base = '15-Cambio de Planes de Estudio 2027/nuevo/LA 484 Correlatividades.pdf';
    assert.equal(stripProvisionalTag('15-Cambio de Planes de Estudio 2027/nuevo/[PROVISORIO] LA 484 Correlatividades.pdf'), base);
    assert.equal(stripProvisionalTag('15-Cambio de Planes de Estudio 2027/nuevo/LA 484 Correlatividades [PROVISORIO].pdf'), base);
    assert.equal(stripProvisionalTag(base), base);
  });
});

describe('aviso de documento provisorio', () => {
  const md = '# Correlatividades LA 2027\n\nRégimen nuevo.\n\n---\n\n## Contenido\n\n| Nº | Asignatura |\n|---|---|\n| 1 | Matemática |\n';

  test('se inserta al comienzo de "## Contenido", una sola vez', () => {
    const once = applyProvisionalNotice(md);
    assert.match(once, /## Contenido\n\n> \*\*Documento provisorio\.\*\*[^\n]*\n\n\| Nº \| Asignatura \|/);
    assert.equal(applyProvisionalNotice(once), once);
  });

  test('sin sección "Contenido" va después del título', () => {
    assert.ok(applyProvisionalNotice('# Planilla\n\nTexto').startsWith(`# Planilla\n\n${PROVISIONAL_NOTICE}\n`));
  });
});

test('la ingesta usa la marca para el slug, el reproceso y el aviso', async () => {
  const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
  assert.match(source, /const slug = slugify\(stripProvisionalTag\(file\.path\)/);
  assert.match(source, /\|\| Boolean\(prevFile\.provisional\) !== provisional/);
  assert.match(source, /&& Boolean\(prevFile\.provisional\) === provisional\) \{/);
  assert.ok(source.indexOf('if (provisional) mdContent = applyProvisionalNotice(mdContent);') < source.indexOf('// 5. Save candidate file'));
  assert.match(source, /sector,\n\s+provisional,\n\s+status: 'candidate',/);
});
