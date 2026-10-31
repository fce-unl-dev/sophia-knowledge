// Convertidores de formatos Office y de imágenes para la ingesta de Drive.
// Los .xlsx/.pptx se arman en memoria con la misma estructura que generan
// Excel y PowerPoint, sin binarios en el repo.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

import { decodeXml, excelSerialToIso, pptxToText, readXlsx, rowsToMarkdownTable, xlsxToMarkdown } from '../office_formats.mjs';
import { extractImageText, IMAGE_EXTRACTION_SYSTEM, PDF_EXTRACTION_SYSTEM, TRANSCRIPTION_CALL } from '../scrape_drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)]))));

// Planilla con la forma de "Info costos carrera para la IA": strings
// compartidos con corridas de formato, números, una fila vacía autocerrada,
// una celda salteada, una hoja oculta y una segunda hoja visible.
function costsWorkbook() {
  return zip({
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>
      <sheet name="Costos 2027" sheetId="1" r:id="rId1"/>
      <sheet name="Borrador" sheetId="2" state="hidden" r:id="rId2"/>
      <sheet name="Notas &amp; aclaraciones" sheetId="3" r:id="rId3"/>
    </sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>
      <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="worksheet" Target="/xl/worksheets/sheet3.xml"/>
    </Relationships>`,
    'xl/sharedStrings.xml': `<sst><si><t>Carrera</t></si><si><t>Matrícula</t></si><si><t>Cuota mensual</t></si>
      <si><r><t>MBA </t></r><r><rPr><b/></rPr><t>(presencial)</t></r></si>
      <si><t>Especialización en Tributación | 2 años</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><cols><col min="1" max="3"/></cols><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2" spans="1:3" ht="20" customHeight="1"/>
      <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>150000</v></c><c r="C3"><v>85000.5</v></c></row>
      <row r="4"><c r="A4" t="s"><v>4</v></c><c r="C4"><v>62000</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>no publicar</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet3.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Aranceles &lt;sujetos&gt; a actualización</t></is></c><c r="B1" t="b"><v>1</v></c></row>
    </sheetData></worksheet>`,
  });
}

describe('readXlsx', () => {
  test('lee hojas visibles en orden y omite la oculta', () => {
    const sheets = readXlsx(costsWorkbook());
    assert.deepEqual(sheets.map((sheet) => sheet.name), ['Costos 2027', 'Notas & aclaraciones']);
  });

  test('resuelve strings compartidos con corridas, números y celdas salteadas', () => {
    const [costs] = readXlsx(costsWorkbook());
    assert.deepEqual(costs.rows, [
      ['Carrera', 'Matrícula', 'Cuota mensual'],
      ['MBA (presencial)', '150000', '85000.5'],
      ['Especialización en Tributación | 2 años', '', '62000'],
    ]);
  });

  test('una fila vacía autocerrada no se come la siguiente', () => {
    const [costs] = readXlsx(costsWorkbook());
    assert.equal(costs.rows.length, 3);
    assert.equal(costs.rows[1][0], 'MBA (presencial)');
  });

  test('cadenas en línea, booleanos y entidades XML', () => {
    const [, notes] = readXlsx(costsWorkbook());
    assert.deepEqual(notes.rows, [['Aranceles <sujetos> a actualización', 'VERDADERO']]);
  });

  test('un archivo que no es ZIP falla con un mensaje legible', () => {
    assert.throws(() => readXlsx(Buffer.from('no soy un excel')), /Archivo Office ilegible/);
  });
});

describe('fechas de Excel', () => {
  // Estilos como los que escribe openpyxl/Excel: xf 1 usa un formato propio de
  // fecha, xf 2 el predefinido 14, xf 3 una moneda con corchetes y xf 4 solo hora.
  const styles = `<styleSheet><numFmts count="3">
      <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
      <numFmt numFmtId="165" formatCode="[$$-409]#,##0.00"/>
      <numFmt numFmtId="166" formatCode="hh:mm"/>
    </numFmts><cellXfs count="5">
      <xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="166"/>
    </cellXfs></styleSheet>`;
  const book = (workbookPr = '') => zip({
    'xl/workbook.xml': `<workbook>${workbookPr}<sheets><sheet name="H" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1">
      <c r="A1" s="1"><v>46447</v></c><c r="B1" s="2"><v>46447</v></c><c r="C1" s="3"><v>46447</v></c>
      <c r="D1" s="4"><v>0.5</v></c><c r="E1" s="1" t="str"><v>a confirmar</v></c><c r="F1"><v>46447</v></c>
    </row></sheetData></worksheet>`,
  });

  test('convierte solo las celdas con formato de fecha', () => {
    const [sheet] = readXlsx(book());
    assert.deepEqual(sheet.rows[0], ['2027-03-01', '2027-03-01', '46447', '0.5', 'a confirmar', '46447']);
  });

  test('respeta el sistema 1904 de Excel viejo de Mac', () => {
    const [sheet] = readXlsx(book('<workbookPr date1904="1"/>'));
    assert.equal(sheet.rows[0][0], '2031-03-02');
  });

  test('seriales con hora y anteriores al 01/03/1900', () => {
    assert.equal(excelSerialToIso(45000.5), '2023-03-15 12:00');
    assert.equal(excelSerialToIso(1), '1900-01-01');
    assert.equal(excelSerialToIso(61), '1900-03-01');
  });
});

describe('xlsxToMarkdown', () => {
  test('una tabla por hoja, sin romper columnas con "|"', () => {
    const md = xlsxToMarkdown(costsWorkbook());
    assert.match(md, /^### Hoja: Costos 2027\n\n\| Carrera \| Matrícula \| Cuota mensual \|\n\| :--- \| :--- \| :--- \|/);
    assert.match(md, /\| Especialización en Tributación \\\| 2 años \|  \| 62000 \|/);
    assert.match(md, /### Hoja: Notas & aclaraciones/);
    assert.doesNotMatch(md, /no publicar/);
  });

  test('rowsToMarkdownTable completa filas cortas', () => {
    assert.equal(rowsToMarkdownTable([['A', 'B'], ['1']]), '| A | B |\n| :--- | :--- |\n| 1 |  |');
  });
});

describe('pptxToText', () => {
  test('texto por diapositiva en orden numérico, un párrafo por línea', () => {
    const deck = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Cierre</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Correlatividades </a:t></a:r><a:r><a:t>2027</a:t></a:r></a:p><a:p><a:r><a:t>Cursado &amp; regularidad</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Taller docente</a:t></a:r></a:p><a:p></a:p></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
    });
    assert.equal(pptxToText(deck),
      '## Diapositiva 1\n\nTaller docente\n\n## Diapositiva 2\n\nCorrelatividades 2027\nCursado & regularidad\n\n## Diapositiva 10\n\nCierre');
  });

  test('un ZIP sin diapositivas falla', () => {
    assert.throws(() => pptxToText(zip({ 'docProps/app.xml': '<x/>' })), /sin diapositivas/);
  });
});

test('decodeXml resuelve entidades con nombre y numéricas', () => {
  assert.equal(decodeXml('&lt;a&gt; &amp;amp; &#241; &#xF1;'), '<a> &amp; ñ ñ');
});

describe('extractImageText', () => {
  test('usa la lectura multimodal con el tipo de la imagen y las opciones de transcripción', async () => {
    let captured;
    const text = await extractImageText(Buffer.from('png'), 'image/png', {
      apiKey: 'KEY',
      callGeminiImpl: async (options) => { captured = options; return { text: '  Afiche: inscripciones abiertas  ' }; },
    });
    assert.equal(text, 'Afiche: inscripciones abiertas');
    assert.equal(captured.fileParts[0].inlineData.mimeType, 'image/png');
    assert.equal(captured.systemInstruction, IMAGE_EXTRACTION_SYSTEM);
    assert.equal(captured.timeoutMs, TRANSCRIPTION_CALL.timeoutMs);
    assert.equal(captured.thinkingBudget, 0);
  });

  test('sin credenciales falla en vez de devolver vacío', async () => {
    await assert.rejects(() => extractImageText(Buffer.from('png'), 'image/png'), /sin GEMINI_API_KEY/);
  });

  test('el prompt de imágenes conserva las reglas de privacidad del de PDF', () => {
    assert.notEqual(IMAGE_EXTRACTION_SYSTEM, PDF_EXTRACTION_SYSTEM);
    assert.match(IMAGE_EXTRACTION_SYSTEM, /Te paso la imagen de un documento/);
    assert.match(IMAGE_EXTRACTION_SYSTEM, /PRIVACIDAD/);
  });
});

test('la extracción enruta los formatos nuevos y Excel no pasa por el modelo', async () => {
  const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
  assert.match(source, /mimeType === 'application\/vnd\.google-apps\.presentation'[\s\S]{0,200}mimeType: 'text\/plain'/);
  assert.match(source, /if \(mimeType === XLSX_MIME\) \{\s*return xlsxToMarkdown\(buffer\);/);
  assert.match(source, /if \(mimeType === PPTX_MIME\) \{\s*return pptxToText\(buffer\);/);
  assert.match(source, /if \(IMAGE_MIMES\.has\(mimeType\)\) \{\s*return extractImageText\(/);
  assert.match(source, /else if \(file\.mimeType === XLSX_MIME\) \{[\s\S]{0,160}formatCsvAsMarkdownComplement\(file\.name, file\.id, file\.modifiedTime, file\.webViewLink, extractedText\)/);
});
