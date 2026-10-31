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

  test('corta la variante "no fue provisto" de la corrida forzada', () => {
    const variant = COMPLETE.replace(/\| Microeconomía I[\s\S]*$/,
      '**Nota:** El contenido detallado de la tabla de correlatividades del anexo no fue provisto en el texto original extraído.');
    assert.equal(checkFormattedComplement(variant).status, 'placeholder-format');
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
    assert.match(source, /TRANSCRIPTION_CALL = Object\.freeze\(\{ timeoutMs: 300_000, maxOutputTokens: 65536, thinkingBudget: 0 \}\)/);
    assert.match(source, /FORMAT_SYSTEM_PROMPT,[\s\S]{0,120}\.\.\.TRANSCRIPTION_CALL/);
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
    assert.match(step, /check_freshness_report\.mjs --kb-root=\. --write\n\s+node tools\/scraper\/check_freshness_report\.mjs --kb-root=\.\n/);
    assert.match(workflow, /git add freshness\.md complementos indice\.json routing_metadata\.json/);
  });

  test('un archivo en estado de error no se saltea como "sin cambios"', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /const hasChanged = values\['force'\] \|\| !prevFile \|\| RETRY_STATUSES\.has\(prevFile\.status\)/);
    const { RETRY_STATUSES } = await import('../scrape_drive.mjs');
    assert.deepEqual([...RETRY_STATUSES].sort(), ['candidate', 'error']);
  });

  test('las tablas van como marcadores al modelo y se controlan antes de guardar', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    const protectAt = source.indexOf('protectTables(extractedText, { sanitize: sanitizeKbMarkdown })');
    const formatAt = source.indexOf('formatComplementWithGemini(apiKey, file, protectedText');
    const restoreAt = source.indexOf('restoreTables(cleanedGeminiContent, tables)');
    const saveAt = source.indexOf('mdContent = `${cleanedGeminiContent}');
    assert.ok(protectAt > 0 && protectAt < formatAt && formatAt < restoreAt && restoreAt < saveAt);
    assert.match(source.slice(restoreAt, saveAt), /checkRestoredTables\(restored, \{ label \}\)\s*\|\| checkFormattedComplement\([\s\S]*?\|\| checkIdentifiers\(extractedText, cleanedGeminiContent, \{ label \}\)/);
  });

  test('el prompt ya no pide resumir tablas y explica los marcadores', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    const prompt = source.slice(source.indexOf('const FORMAT_SYSTEM_PROMPT'), source.indexOf('`;', source.indexOf('const FORMAT_SYSTEM_PROMPT')));
    assert.doesNotMatch(prompt, /resumen estructurado|visión general sintética|NO intentes transcribir/);
    assert.match(prompt, /\[\[TABLA_1\]\]/);
    assert.match(prompt, /Copiá cada marcador exactamente una vez/);
  });
});
