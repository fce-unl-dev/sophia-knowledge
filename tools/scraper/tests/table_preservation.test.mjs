// Preservación de tablas y control de identificadores al formatear complementos.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkIdentifiers, checkRestoredTables, checkTranscriptionSanity, extractIdentifiers, joinTranscribedChunks, protectTables, restoreTables, tableMarker } from '../table_preservation.mjs';

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

describe("joinTranscribedChunks", () => {
  const HEADER = "| Asignaturas | Correlatividad para aprobar o promocionar | Correlatividad para cursar |";
  const tramo1 = [
    "Anexo: régimen de correlatividades",
    "",
    HEADER,
    "| :--- | :--- | :--- |",
    "| 9 Matemática Aplicada | Matemática Básica (aprobada) | |",
    "| 10 Derecho Laboral y Seguridad Social | Instituciones del Derecho (aprobada) | |",
  ].join("\n");

  test("une la tabla cuando el tramo siguiente toma una fila de datos como encabezado (CP 482)", () => {
    const tramo2 = [
      "| 11 Matemática Financiera | Matemática Básica (aprobada) - Matemática Aplicada (aprobada) | |",
      "| :--- | :--- | :--- |",
      "| 12 Economía Aplicada | Economía Básica (aprobada) | |",
    ].join("\n");
    const joined = joinTranscribedChunks([tramo1, tramo2]);
    assert.equal(joined.match(/^\| :---/gm).length, 1, "un solo separador");
    assert.match(joined, /\| 10 Derecho Laboral[^\n]*\n\| 11 Matemática Financiera[^\n]*\n\| 12 Economía Aplicada/);
    assert.equal(protectTables(joined).tables.length, 1);
  });

  test("descarta el encabezado repetido por el tramo siguiente", () => {
    const tramo2 = [`  ${HEADER.toUpperCase()}`, "|---|---|---|", "| 11 Matemática Financiera | Matemática Básica (aprobada) | |"].join("\n");
    const joined = joinTranscribedChunks([tramo1, tramo2]);
    assert.equal(joined.split("\n").filter((line) => line.toLowerCase().includes("asignaturas")).length, 1);
    assert.equal(protectTables(joined).tables[0].split("\n").length, 5);
  });

  test("tres tramos de la misma tabla quedan en una sola", () => {
    const fila = (n) => `| ${n} Materia ${n} | | |`;
    const joined = joinTranscribedChunks([tramo1, `${fila(11)}\n| :--- | :--- | :--- |\n${fila(12)}`, `${fila(23)}\n| :--- | :--- | :--- |\n${fila(24)}`]);
    const { tables } = protectTables(joined);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].split("\n").length, 8);
  });

  test("no une tablas con distinta cantidad de columnas ni tramos que no empiezan en tabla", () => {
    const otraTabla = "| Año | Materias |\n|---|---|\n| 1º | 6 |";
    assert.equal(protectTables(joinTranscribedChunks([tramo1, otraTabla])).tables.length, 2);
    const conTexto = joinTranscribedChunks([tramo1, "ARTÍCULO 2º.- Inscríbase.", "Fin"]);
    assert.match(conTexto, /\| 10 Derecho[^\n]*\n\nARTÍCULO 2º\.- Inscríbase\.\n\nFin$/);
  });

  test("ignora tramos vacíos", () => {
    assert.equal(joinTranscribedChunks(["", "  uno ", null, "dos"]), "uno\n\ndos");
  });
});

test("la lectura por tramos une las tablas al juntar los tramos", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../scrape_drive.mjs"), "utf8");
  assert.match(source, /const ocr = joinTranscribedChunks\(chunks\);/);
});

describe('checkTranscriptionSanity', () => {
  const header = '| Asignaturas | Para aprobar | Para cursar |\n| :--- | :--- | :--- |';
  const filas = (desde, hasta) => Array.from({ length: hasta - desde + 1 }, (_, i) => `| ${desde + i} Materia ${desde + i} | — | — |`).join('\n');

  test('acepta una tabla completa y numerada (CP 482)', () => {
    assert.equal(checkTranscriptionSanity(`${header}\n| **1º AÑO** | | |\n${filas(1, 29)}`), null);
  });

  test('detecta la tabla inventada en inglés de LA 484', () => {
    const inventada = '| Rank | Word |\n|---|---|\n' + ['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'I', 'it', 'for', 'not', 'on', 'with'].map((word, i) => `| ${i + 1} | ${word} |`).join('\n');
    const hit = checkTranscriptionSanity(`${header}\n${filas(1, 30)}\n\n${inventada}`, { label: 'el documento "LA 484.pdf"' });
    assert.equal(hit.status, 'hallucinated-table');
    assert.match(hit.reason, /LA 484\.pdf.*inglés.*inventó contenido/);
  });

  test('detecta las materias faltantes de LA 484 (11 → 28)', () => {
    const hit = checkTranscriptionSanity(`${header}\n${filas(1, 11)}\n${filas(28, 30)}`);
    assert.equal(hit.status, 'numbering-gaps');
    assert.match(hit.reason, /hasta 30 pero faltan 16 \(12, 13, 14/);
  });

  test('no opina sobre tablas cortas, sin numerar o con códigos grandes', () => {
    assert.equal(checkTranscriptionSanity(`${header}\n${filas(1, 3)}\n${filas(8, 9)}`), null);
    assert.equal(checkTranscriptionSanity('| Año | Materias |\n|---|---|\n| 1º | 6 |'), null);
    assert.equal(checkTranscriptionSanity('| Código | Materia |\n|---|---|\n| 1015 | Matemática |\n| 2035 | Contabilidad II |'), null);
  });

  test('unas pocas palabras en inglés legítimas no disparan la guarda', () => {
    assert.equal(checkTranscriptionSanity('| Materia | Observaciones |\n|---|---|\n| Inglés I | Contenidos: to be, have, the |'), null);
  });
});

test('el scrape frena una transcripción alucinada antes de formatear', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../scrape_drive.mjs'), 'utf8');
  const sanityAt = source.indexOf('checkTranscriptionSanity(extractedText');
  assert.ok(sanityAt > source.indexOf('checkRawFloor(extractedText') && sanityAt < source.indexOf('formatComplementWithGemini(apiKey, file, protectedText'));
});
