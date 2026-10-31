// Preservación de tablas y control de identificadores al formatear complementos.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkIdentifiers, checkRestoredTables, extractIdentifiers, protectTables, restoreTables, tableMarker } from '../table_preservation.mjs';

const CORRELATIVIDADES = `| Asignatura | Correlatividad para aprobar | Correlatividad para cursar |
| :--- | :--- | :--- |
| Contabilidad II | Contabilidad I | Contabilidad I (regular) |
| Costos I | Contabilidad II | Contabilidad II (regular) |`;

const SOURCE = `RESOLUCIÓN C.S. N° 482/26 — Expte. FCE-1303855-26

Visto la Res. C.D. n.º 752/26 que propone el régimen de correlatividades.

${CORRELATIVIDADES}

Consultas: academica@fce.unl.edu.ar

| Año | Materias |
|---|---|
| 1º | 6 |`;

describe('protectTables', () => {
  test('reemplaza cada tabla por un marcador y la guarda entera', () => {
    const { text, tables } = protectTables(SOURCE);
    assert.equal(tables.length, 2);
    assert.equal(tables[0], CORRELATIVIDADES);
    assert.match(text, /\n\[\[TABLA_1\]\]\n/);
    assert.match(text, /\[\[TABLA_2\]\]/);
    assert.doesNotMatch(text, /Contabilidad II/);
    assert.match(text, /Expte\. FCE-1303855-26/);
  });

  test('no confunde una línea suelta con barras con una tabla', () => {
    const { tables } = protectTables('Opciones: | A | B |\n| sin separador |\nTexto');
    assert.equal(tables.length, 0);
  });

  test('aplica el limpiador a cada tabla guardada', () => {
    const { tables } = protectTables(`| A |\n| :${'-'.repeat(5000)} |\n| 1 |`, { sanitize: (table) => table.replace(/-{4,}/g, '---') });
    assert.equal(tables[0], '| A |\n| :--- |\n| 1 |');
  });
});

describe('restoreTables', () => {
  const { text, tables } = protectTables(SOURCE);

  test('vuelve a insertar las tablas exactas, aunque el marcador venga en negrita o código', () => {
    const formatted = `# Correlatividades CP\n\n## Contenido\n\n**[[TABLA_1]]**\n\nResumen por año:\n\n\`[[TABLA_2]]\``;
    const restored = restoreTables(formatted, tables);
    assert.equal(checkRestoredTables(restored), null);
    assert.ok(restored.text.includes(CORRELATIVIDADES));
    assert.doesNotMatch(restored.text, /TABLA_/);
  });

  test('detecta marcadores perdidos, repetidos o inventados', () => {
    const restored = restoreTables(`${tableMarker(1)}\n${tableMarker(1)}\n${tableMarker(7)}`, tables);
    assert.deepEqual(restored.missing, [2]);
    assert.deepEqual(restored.duplicated, [1]);
    assert.deepEqual(restored.unknown, [7]);
    const hit = checkRestoredTables(restored, { label: 'el documento "CP 482.pdf"' });
    assert.equal(hit.status, 'lost-tables');
    assert.match(hit.reason, /CP 482\.pdf.*faltan \[\[TABLA_2\]\].*se repiten \[\[TABLA_1\]\].*inexistentes \[\[TABLA_7\]\]/);
  });

  test('un documento sin tablas no exige marcadores', () => {
    assert.equal(checkRestoredTables(restoreTables('# Solo texto', [])), null);
    assert.ok(text.length > 0);
  });
});

describe('checkIdentifiers', () => {
  test('reconoce resoluciones y mails; no fechas ni expedientes', () => {
    const ids = extractIdentifiers(`${SOURCE}\nInscripciones del 10/12 al 20/12. Ordenanza C.S. N° 4/18.`);
    assert.deepEqual([...ids].sort(), ['4/18', '482/26', '752/26', 'academica@fce.unl.edu.ar']);
  });

  test('omitir el expediente no cuenta como pérdida (falso positivo de CP 482)', () => {
    const output = 'Res. CS 482/26, que reemplaza la 752/26. Contacto: academica@fce.unl.edu.ar';
    assert.equal(checkIdentifiers(SOURCE, output), null);
  });

  test('una resolución escrita con otro formato sigue presente', () => {
    const output = 'Resolución C.S. N° 482 del 2026, que reemplaza la Res. CD 752/2026. Contacto: academica@fce.unl.edu.ar';
    assert.equal(checkIdentifiers(SOURCE, output), null);
    assert.ok(checkIdentifiers(SOURCE, 'Res. 4820/26 y 1752/26 · academica@fce.unl.edu.ar'), 'otros números que solo contienen los dígitos no cuentan');
  });

  test('acepta un formateo que conserva los identificadores', () => {
    const output = 'Res. CS 482/26 (Expte. FCE-1303855-26), que reemplaza la 752/26. Contacto: academica@fce.unl.edu.ar';
    assert.equal(checkIdentifiers(SOURCE, output), null);
  });

  test('corta un formateo que resumió de más', () => {
    const hit = checkIdentifiers(SOURCE, 'Resolución sobre correlatividades de Contador Público.', { label: 'el documento "CP 482.pdf"' });
    assert.equal(hit.status, 'lost-identifiers');
    assert.equal(hit.missing.length, 3);
    assert.match(hit.reason, /perdió 3 de 3 identificadores/);
  });

  test('con menos de tres identificadores no opina', () => {
    assert.equal(checkIdentifiers('Res. 1/26 y Res. 2/26', 'nada'), null);
  });
});

describe("integración con la ingesta de Drive", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scrapeSource = () => readFile(join(here, "../scrape_drive.mjs"), "utf8");

  test("las tablas van como marcadores al modelo y se controlan antes de guardar", async () => {
    const source = await scrapeSource();
    const protectAt = source.indexOf("protectTables(extractedText, { sanitize: sanitizeKbMarkdown })");
    const formatAt = source.indexOf("formatComplementWithGemini(apiKey, file, protectedText");
    const restoreAt = source.indexOf("restoreTables(cleanedGeminiContent, tables)");
    const saveAt = source.indexOf("mdContent = `${cleanedGeminiContent}");
    assert.ok(protectAt > 0 && protectAt < formatAt && formatAt < restoreAt && restoreAt < saveAt);
    assert.match(source.slice(restoreAt, saveAt), /checkRestoredTables\(restored, \{ label \}\)\s*\|\| checkFormattedComplement\([\s\S]*?\|\| checkIdentifiers\(extractedText, cleanedGeminiContent, \{ label \}\)/);
  });

  test("el prompt ya no pide resumir tablas y explica los marcadores", async () => {
    const source = await scrapeSource();
    const start = source.indexOf("const FORMAT_SYSTEM_PROMPT");
    const prompt = source.slice(start, source.indexOf("`;", start));
    assert.doesNotMatch(prompt, /resumen estructurado|visión general sintética|NO intentes transcribir/);
    assert.match(prompt, /\[\[TABLA_1\]\]/);
    assert.match(prompt, /Copiá cada marcador exactamente una vez/);
  });
});
