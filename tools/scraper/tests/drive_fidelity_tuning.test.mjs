// Ajustes posteriores a la corrida de verificación 41203878724 (31/10/2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { csvToMarkdownTable, REJECTED_DIR } from '../scrape_drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('una celda de planilla con saltos de línea o barras no rompe la tabla', () => {
  // Fila real de "Info costos carrera para la IA": el contacto venía en tres renglones.
  const csv = 'Carrera,Contacto\n"Diplomatura en bionegocios","Información de contacto\nWhatsApp: 362 421 5114\necoposgrado@comunidad.unne.edu.ar"\n"A | B",x';
  const table = csvToMarkdownTable(csv);
  const lines = table.split('\n');
  assert.equal(lines.length, 4, 'encabezado, separador y dos filas');
  assert.equal(lines[2], '| Diplomatura en bionegocios | Información de contacto · WhatsApp: 362 421 5114 · ecoposgrado@comunidad.unne.edu.ar |');
  assert.equal(lines[3], '| A \\| B | x |');
});

test('el scrape guarda lo rechazado y solo sale por mail al responsable', async () => {
  const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
  assert.equal(REJECTED_DIR, 'rejected');
  const hitAt = source.indexOf('if (formatHit) {');
  const block = source.slice(hitAt, source.indexOf('throw new Error(formatHit.reason)', hitAt));
  assert.match(block, /writeFile\(join\(stateDir, REJECTED_DIR, `\$\{slug\}\.md`\)/);

  // El repo es público: un artefacto del run lo podría bajar cualquiera.
  const workflow = await readFile(join(here, '../../../.github/workflows/ingest-drive.yml'), 'utf8');
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.match(workflow, /send_drive_notifications\.mjs \\\n\s+tools\/scraper\/state\/complementos\/last_run_report\.json "\$state" \\\n\s+tools\/scraper\/state\/complementos\/rejected/);
});
