// Guarda sobre la salida del formateo de complementos de Drive.
//
// Los fixtures son los dos casos reales de la PR #341 (30/10/2026): el plan de
// Contador Público 2027 salió sin cuerpo, y las correlatividades de Lic. en
// Economía 2027 salieron con "Contenido no provisto" en cada celda. En los dos
// el texto extraído del PDF era bueno: el que fallaba era el formateo.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkFormattedComplement, DEFAULT_MIN_DOC_CHARS } from '../guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const COMPLETE = `# Correlatividades — Licenciatura en Economía (Plan 2027)

## Para qué sirve

Define qué asignaturas hay que tener aprobadas para cursar o promocionar cada materia del plan 2027.

## Contenido

| Asignatura | Correlatividad para aprobar o promocionar |
| :--- | :--- |
| Microeconomía I | Introducción a la Economía, Matemática como Lenguaje |
| Macroeconomía I | Introducción a la Economía |
| Econometría I | Estadística II, Microeconomía I |`;

const PLACEHOLDER = `# Correlatividades — Licenciatura en Economía (Plan 2027)

## Para qué sirve

Establece el régimen de correlatividades del nuevo plan de estudios de la Licenciatura en Economía.

## Contenido

A continuación se detalla el régimen de correlatividades según lo provisto en el texto extraído del documento original:

| Asignaturas | Correlatividad para aprobar o promocionar |
| :--- | :--- |
| *(Contenido no provisto en el texto extraído)* | *(Contenido no provisto en el texto extraído)* |`;

describe('checkFormattedComplement', () => {
  test('acepta un complemento completo', () => {
    assert.equal(checkFormattedComplement(COMPLETE), null);
  });

  test('corta el cuerpo vacío del plan de Contador Público 2027', () => {
    const hit = checkFormattedComplement('');
    assert.equal(hit.status, 'hollow-format');
    assert.equal(hit.formatted_length, 0);
    assert.equal(hit.min_doc_chars, DEFAULT_MIN_DOC_CHARS);
  });

  test('corta las correlatividades con "Contenido no provisto"', () => {
    const hit = checkFormattedComplement(PLACEHOLDER);
    assert.equal(hit.status, 'placeholder-format');
    assert.match(hit.reason, /Contenido no provisto/);
  });

  test('corta una salida truncada por límite de tokens aunque parezca completa', () => {
    const hit = checkFormattedComplement(COMPLETE, { finishReason: 'MAX_TOKENS' });
    assert.equal(hit.status, 'truncated-format');
  });

  test('un finishReason normal no cambia el veredicto', () => {
    assert.equal(checkFormattedComplement(COMPLETE, { finishReason: 'STOP' }), null);
  });

  test('incluye la etiqueta del documento en el motivo', () => {
    const hit = checkFormattedComplement('', { label: 'el documento "plan.pdf"' });
    assert.match(hit.reason, /plan\.pdf/);
  });
});

describe('scrape_drive conecta la guarda y reintenta los errores', () => {
  test('el formateo devuelve finishReason y valida antes de guardar', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /maxOutputTokens: 65536/);
    assert.match(source, /checkFormattedComplement\(cleanedGeminiContent, \{\s*finishReason,/);
    assert.ok(source.indexOf('checkFormattedComplement(cleanedGeminiContent') < source.indexOf('mdContent = `${cleanedGeminiContent}'));
  });

  test('la ingesta regenera freshness.md antes de validar y lo incluye en la PR', async () => {
    const workflow = await readFile(join(here, '../../../.github/workflows/ingest-drive.yml'), 'utf8');
    const applyAt = workflow.indexOf('- name: Apply candidates to KB');
    const freshnessAt = workflow.indexOf('- name: Refresh canonical freshness after Drive updates');
    const validateAt = workflow.indexOf('- name: Validate proposed KB before Git mutation');
    assert.ok(applyAt >= 0 && applyAt < freshnessAt && freshnessAt < validateAt);
    const step = workflow.slice(freshnessAt, validateAt);
    assert.match(step, /freshness_report\.mjs --kb-root=\.\.\/\.\. --format=md --reference-date="\$reference_date" --out=freshness\.md/);
    assert.match(step, /check_freshness_report\.mjs --kb-root=\./);
    assert.match(workflow, /git add complementos indice\.json routing_metadata\.json freshness\.md/);
  });

  test('un archivo en estado de error no se saltea como "sin cambios"', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /const hasChanged = values\['force'\] \|\| !prevFile \|\| prevFile\.status === 'error'/);
  });
});
