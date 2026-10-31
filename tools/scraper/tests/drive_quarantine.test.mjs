// Cuarentena visible de la ingesta de Drive. Los mensajes son los reales de las
// corridas del 30/10/2026 (41081064131, 41133580579 y 41141679168).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { diagnoseDriveError, renderQuarantineMarkdown, renderWarnings, writeRunReport } from '../drive_quarantine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pdf = { path: '15-Cambio de Planes de Estudio 2027/nuevo/CP 481.pdf', name: 'CP 481.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/x/view' };

describe('diagnoseDriveError', () => {
  const cases = [
    ['formato', { ...pdf, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      'MIME type no soportado: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', /Hoja de cálculo de Google/],
    ['formato', { ...pdf, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      'MIME type no soportado: application/vnd.openxmlformats-officedocument.presentationml.presentation', /Presentación de Google o exportalo a PDF/],
    ['sin-texto', pdf,
      'el scrape de el documento "x.pdf" trajo 12 caracteres útiles, por debajo del mínimo de 200. No se generó contenido.', /texto seleccionable/],
    ['demasiado-largo', pdf,
      'el formateo de el documento "CP 481.pdf" se cortó por límite de tokens de salida. Guardarlo dejaría el documento incompleto sin aviso.', /dividirlo/],
    ['transcripcion-incompleta', pdf,
      'el formateo de el documento "LE 486.pdf" declara contenido faltante ("Contenido no provisto"). El documento quedaría con apartados vacíos.', /Hoja de cálculo de Google/],
    ['transcripcion-incompleta', pdf,
      'el formateo de el documento "x.pdf" devolvió 0 caracteres útiles, por debajo del mínimo de 200, aunque el texto extraído superó el piso.', /Se reintenta solo/],
    ['transitorio', pdf, 'This operation was aborted', /no hace falta hacer nada/],
    ['transitorio', pdf, 'Gemini response sin texto: {"candidates":[]}', /no hace falta hacer nada/],
    ['otro', pdf, 'algo inesperado', /log de la corrida/],
  ];
  for (const [kind, file, message, advice] of cases) {
    test(`${kind}: ${message.slice(0, 50)}`, () => {
      const result = diagnoseDriveError(file, message);
      assert.equal(result.kind, kind);
      assert.match(result.advice, advice);
      assert.equal(result.path, file.path);
      assert.equal(result.reason, message);
    });
  }
});

describe('renderQuarantineMarkdown', () => {
  test('vacío sin errores', () => {
    assert.equal(renderQuarantineMarkdown([]), '');
  });

  test('una fila por archivo, con enlace y sin romper la tabla', () => {
    const md = renderQuarantineMarkdown([
      diagnoseDriveError(pdf, 'This operation was aborted'),
      diagnoseDriveError({ path: 'a | b.xlsx', mimeType: 'application/vnd.ms-excel' }, 'MIME type no soportado: x'),
    ]);
    assert.match(md, /^## No procesados/);
    assert.match(md, /2 archivo\(s\)/);
    assert.match(md, /\| \[15-Cambio de Planes de Estudio 2027\/nuevo\/CP 481\.pdf\]\(https:\/\/drive\.google\.com\/file\/d\/x\/view\) \| Falla temporal \|/);
    assert.match(md, /\| a \\\| b\.xlsx \| Formato no soportado \|/);
  });

  test('las advertencias de Actions llevan archivo e indicación', () => {
    const lines = renderWarnings([diagnoseDriveError(pdf, 'This operation was aborted')]);
    assert.match(lines, /^::warning title=Drive no procesado::15-Cambio de Planes.*CP 481\.pdf: Falla temporal/);
  });
});

describe('CLI del workflow', () => {
  const cli = (...args) => spawnSync(process.execPath, [join(here, '../drive_quarantine.mjs'), ...args], { encoding: 'utf8' });

  test('un reporte ausente cuenta como sin errores', () => {
    const result = cli('count', '/no/existe.json');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '0\n');
    assert.equal(cli('markdown', '/no/existe.json').stdout, '');
  });

  test('lee el reporte que escribe la ingesta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-quarantine-'));
    const report = join(dir, 'last_run_report.json');
    await writeRunReport(report, [diagnoseDriveError(pdf, 'This operation was aborted')], new Date('2026-10-31T12:00:00Z'));
    assert.equal(JSON.parse(await readFile(report, 'utf8')).generatedAt, '2026-10-31T12:00:00.000Z');
    assert.equal(cli('count', report).stdout, '1\n');
    assert.match(cli('markdown', report).stdout, /## No procesados/);
    assert.match(cli('warnings', report).stdout, /::warning/);
  });

  test('un comando desconocido falla', () => {
    assert.equal(cli('otro', '/x').status, 2);
  });
});

describe('integración con la ingesta', () => {
  test('el scrape registra cada error y escribe el reporte', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /runErrors\.push\(diagnoseDriveError\(file, err\.message\)\)/);
    assert.match(source, /await writeRunReport\(join\(stateDir, RUN_REPORT_FILE\), runErrors\)/);
  });

  test('el workflow publica el resumen, suma la sección a la PR y mantiene el issue', async () => {
    const workflow = await readFile(join(here, '../../../.github/workflows/ingest-drive.yml'), 'utf8');
    assert.match(workflow, /permissions:\n  contents: write\n  pull-requests: write\n  issues: write/);
    const scrapeAt = workflow.indexOf('- name: Scrape Drive (write candidates)');
    const publishAt = workflow.indexOf('- name: Publish unprocessed Drive files');
    const prAt = workflow.indexOf('- name: Open human-review PR');
    const issueAt = workflow.indexOf('- name: Track unprocessed Drive files in an issue');
    assert.ok(scrapeAt < publishAt && publishAt < prAt && prAt < issueAt);
    assert.match(workflow.slice(publishAt, prAt), /GITHUB_STEP_SUMMARY/);
    const prStep = workflow.slice(prAt, issueAt);
    assert.ok(prStep.indexOf('drive-quarantine.md') < prStep.indexOf('git commit -m "$commit_message"'));
    const issueStep = workflow.slice(issueAt, workflow.indexOf('- name: Fail on removal anomaly'));
    assert.match(issueStep, /steps\.scrape\.outcome == 'success'/);
    assert.match(issueStep, /gh issue close/);
  });
});
