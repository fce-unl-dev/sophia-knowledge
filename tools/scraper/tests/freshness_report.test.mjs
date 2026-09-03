import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateFreshnessReport,
  parseHumanReviewMetadata,
  parseReferenceDate,
} from '../freshness_report.mjs';
import { checkFreshnessReport } from '../check_freshness_report.mjs';

const tempRoots = [];

async function createFixture() {
  const kbRoot = await mkdtemp(join(tmpdir(), 'sophia-freshness-'));
  tempRoots.push(kbRoot);
  const stateDir = join(kbRoot, 'tools/scraper/state');
  await mkdir(join(kbRoot, 'tools/scraper'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(kbRoot, 'posgrados'), { recursive: true });
  await writeFile(join(kbRoot, 'indice.json'), JSON.stringify({
    items: [{ path: 'posgrados/programa.md', title: 'Programa', category: 'Posgrado' }],
  }));
  await writeFile(join(kbRoot, 'tools/scraper/sources.json'), JSON.stringify({
    sources: [{ slug: 'programa', indice_path: 'posgrados/programa.md' }],
  }));
  await writeFile(join(kbRoot, 'tools/scraper/state/programa.meta.json'), JSON.stringify({
    last_checked_at: '2026-08-31T10:00:00.000Z',
  }));
  return { kbRoot, stateDir };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('parseHumanReviewMetadata', () => {
  test('clasifica el draft que escribe el generador', () => {
    const result = parseHumanReviewMetadata(
      '**Última revisión humana**: PENDIENTE — draft autogenerado el 2026-08-30 por pipeline de scraping.',
    );
    assert.equal(result.reviewStatus, 'Draft autogenerado');
    assert.equal(result.isDraft, true);
    assert.equal(result.humanDate?.toISOString().slice(0, 10), '2026-08-30');
  });

  test('clasifica la fecha ISO que escribe el workflow post-merge', () => {
    const result = parseHumanReviewMetadata('**Última revisión humana**: 2026-09-03');
    assert.equal(result.reviewStatus, 'Revisado');
    assert.equal(result.isDraft, false);
    assert.equal(result.humanDate?.toISOString().slice(0, 10), '2026-09-03');
  });

  test('clasifica una revisión pendiente sin fecha de draft', () => {
    assert.deepEqual(parseHumanReviewMetadata('**Última revisión humana**: PENDIENTE — requiere revisión editorial.'), {
      reviewStatus: 'Pendiente / N/D', isDraft: false, humanDate: null,
    });
  });

  test('conserva pendiente cuando no existe metadata reconocible', () => {
    assert.deepEqual(parseHumanReviewMetadata('# Sin metadata'), {
      reviewStatus: 'Pendiente / N/D', isDraft: false, humanDate: null,
    });
  });
});

describe('freshness report', () => {
  test('es determinista con una fecha de referencia provista', async () => {
    const { kbRoot, stateDir } = await createFixture();
    await writeFile(join(kbRoot, 'posgrados/programa.md'), '**Última revisión humana**: 2026-08-30\n');

    const report = await generateFreshnessReport({
      kbRoot,
      stateDir,
      format: 'md',
      today: parseReferenceDate('2026-09-03'),
    });

    assert.match(report, /\*\*Generado el:\*\* 2026-09-03/);
    assert.match(report, /Revisado \| 🟢 4 d \(2026-08-30\) \| 🟢 2 d \(2026-08-31\)/);
  });

  test('el chequeo reproduce la fecha versionada sin consultar el reloj', async () => {
    const { kbRoot, stateDir } = await createFixture();
    await writeFile(join(kbRoot, 'posgrados/programa.md'), '**Última revisión humana**: PENDIENTE — draft autogenerado el 2026-08-30 por pipeline.\n');
    const report = await generateFreshnessReport({
      kbRoot, stateDir, format: 'md', today: parseReferenceDate('2026-09-03'),
    });
    await writeFile(join(kbRoot, 'freshness.md'), report);

    await checkFreshnessReport({ kbRoot, stateDir });

    await writeFile(join(kbRoot, 'posgrados/programa.md'), '**Última revisión humana**: 2026-09-03\n');
    await assert.rejects(
      () => checkFreshnessReport({ kbRoot, stateDir }),
      /freshness\.md está desactualizado/,
    );
  });
});
