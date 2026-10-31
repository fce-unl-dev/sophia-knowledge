// Reemplazo de un archivo de Drive por otro con el mismo nombre y distinto tipo.
//
// Caso real (ingesta del 30/10/2026): "Info costos carrera para la IA.xlsx" se
// reemplazó por una Hoja de cálculo de Google con el mismo nombre. Los dos
// generan el slug 04-posgrado-info-costos-carrera-para-la-ia, y la baja del
// .xlsx borró el candidato de la planilla nueva; el apply siguió "con éxito" y
// la planilla quedó como candidate para siempre, sin llegar al KB.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { liveSlugs } from '../scrape_drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SLUG = '04-posgrado-info-costos-carrera-para-la-ia';

describe('liveSlugs', () => {
  test('incluye archivos vigentes y excluye bajas', () => {
    const slugs = liveSlugs({
      xlsx: { slug: SLUG, status: 'deleted' },
      sheet: { slug: SLUG, status: 'candidate' },
      old: { slug: 'otro', status: 'deleted' },
    });
    assert.deepEqual([...slugs], [SLUG]);
  });

  test('tolera estado vacío', () => {
    assert.equal(liveSlugs(undefined).size, 0);
  });
});

describe('apply con slug compartido entre baja y reemplazo', () => {
  test('copia el reemplazo, no lo borra y marca en error un candidato ausente', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sophia-drive-slug-'));
    const sourceScraper = join(here, '..');
    const scraperDir = join(root, 'tools/scraper');
    const stateDir = join(scraperDir, 'state/complementos');
    await mkdir(join(root, 'tools'), { recursive: true });
    await cp(sourceScraper, scraperDir, { recursive: true, filter: (source) => !source.endsWith('/node_modules') });
    await symlink(join(sourceScraper, 'node_modules'), join(scraperDir, 'node_modules'));
    await mkdir(join(root, 'complementos'), { recursive: true });
    await mkdir(join(stateDir, 'candidates'), { recursive: true });

    const state = { files: {
      a: { id: 'a', path: 'Drive/a.pdf', slug: 'drive-a', status: 'synchronized' },
      b: { id: 'b', path: 'Drive/b.pdf', slug: 'drive-b', status: 'synchronized' },
      xlsx: { id: 'xlsx', name: 'Info costos carrera para la IA.xlsx', path: '04-Posgrado/Info costos carrera para la IA.xlsx', slug: SLUG, status: 'deleted' },
      sheet: { id: 'sheet', name: 'Info costos carrera para la IA', path: '04-Posgrado/Info costos carrera para la IA', slug: SLUG, status: 'candidate', sector: 'posgrados_graduados', webViewLink: 'https://drive.google.com/file/d/sheet/view' },
      lost: { id: 'lost', name: 'Perdido.pdf', path: 'Drive/Perdido.pdf', slug: 'drive-perdido', status: 'candidate' },
    } };
    await writeFile(join(stateDir, 'drive.meta.json'), JSON.stringify(state, null, 2) + '\n');
    await writeFile(join(stateDir, 'candidates', `${SLUG}.md`), '# Costos de carreras de posgrado\n\n| Carrera | Arancel |\n');
    await writeFile(join(root, 'indice.json'), JSON.stringify({ version: 3, items: [
      { path: 'complementos/drive-a.md', title: 'A' },
      { path: 'complementos/drive-b.md', title: 'B' },
    ] }, null, 2) + '\n');
    await writeFile(join(root, 'complementos/drive-a.md'), '# A\n');
    await writeFile(join(root, 'complementos/drive-b.md'), '# B\n');

    const result = spawnSync(process.execPath, [
      await realpath(join(scraperDir, 'scrape_drive.mjs')), '--apply',
      `--kb-root=${await realpath(root)}`, `--out=${await realpath(stateDir)}`,
    ], { cwd: scraperDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const docPath = join(root, 'complementos', `${SLUG}.md`);
    assert.ok(existsSync(docPath), 'la planilla de reemplazo debe quedar en el KB');
    assert.match(await readFile(docPath, 'utf8'), /Costos de carreras de posgrado/);
    const index = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
    assert.ok(index.items.some((item) => item.path === `complementos/${SLUG}.md`));

    const after = JSON.parse(await readFile(join(stateDir, 'drive.meta.json'), 'utf8'));
    assert.equal(after.files.sheet.status, 'synchronized');
    assert.equal(after.files.xlsx, undefined, 'la baja sale del estado');
    assert.equal(after.files.lost.status, 'error', 'un candidato ausente se reintenta en la próxima corrida');
  });
});

describe('scrape no borra el candidato de un slug vigente', () => {
  test('la detección de bajas consulta liveSlugs antes de borrar', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /const keepSlugs = liveSlugs\(newFilesState\);/);
    assert.match(source, /if \(!keepSlugs\.has\(prevFile\.slug\) && existsSync\(candPath\)\)/);
  });
});
