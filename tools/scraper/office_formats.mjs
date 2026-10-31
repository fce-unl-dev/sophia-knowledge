// Lectura determinística de formatos Office que la ingesta de Drive no podía
// procesar ("MIME type no soportado"). Caso que lo motivó: "Info costos carrera
// para la IA.xlsx" (30/10/2026), que quedó afuera del KB hasta que alguien la
// convirtió a mano a Hoja de cálculo de Google.
//
// Un .xlsx o .pptx es un ZIP de XML generado por programas, con una estructura
// fija: alcanza con descomprimir (fflate, sin dependencias) y leer las pocas
// etiquetas que llevan contenido. Las planillas no pasan por el modelo: las
// celdas se copian tal cual, que es justo lo que un LLM hace peor.

import { strFromU8, unzipSync } from 'fflate';

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

export function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity.toLowerCase()];
  });
}

function attributes(tag) {
  const result = {};
  for (const [, name, value] of tag.matchAll(/([\w:]+)="([^"]*)"/g)) result[name] = decodeXml(value);
  return result;
}

// Concatena el texto de todas las <t> (o <a:t>) de un fragmento, incluidas las
// corridas con formato distinto dentro de una misma celda o párrafo.
function textRuns(fragment, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...fragment.matchAll(pattern)].map((match) => decodeXml(match[1])).join('');
}

function readZip(buffer) {
  try {
    return unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`Archivo Office ilegible (no es un ZIP válido): ${error.message}`);
  }
}

function entry(files, path) {
  const data = files[path];
  return data ? strFromU8(data) : null;
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(reference || '')?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

// Formatos numéricos de fecha predefinidos por Excel (ECMA-376, 18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

// Un formato propio es de fecha si usa d/m/y fuera de literales y colores.
// Las "m" de minutos (h:mm, mm:ss) se descartan antes: no son meses.
function isDateFormatCode(code) {
  const bare = code
    .replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
    .replace(/h+\s*:\s*m+|m+\s*:\s*s+/gi, '');
  return /[dmy]/i.test(bare);
}

// Índices de estilo de celda (atributo s) que muestran el número como fecha.
function dateStyleIndexes(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map([...stylesXml.matchAll(/<numFmt\b[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .map((format) => [Number(format.numFmtId), format.formatCode || '']));
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || '';
  const indexes = new Set();
  [...cellXfs.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], index) => {
    const id = Number(attributes(tag).numFmtId);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)))) indexes.add(index);
  });
  return indexes;
}

// Serial de Excel a AAAA-MM-DD, con hora si la tiene. En el sistema 1900,
// Excel cuenta un 29/02/1900 inexistente: los seriales menores a 61 corren un día.
// Los libros con date1904 (Excel viejo de Mac) cuentan desde el 01/01/1904.
export function excelSerialToIso(serial, { date1904 = false } = {}) {
  const value = Number(serial);
  if (!Number.isFinite(value)) return String(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, value < 61 ? 31 : 30);
  const date = new Date(epoch + Math.round(value * 86400000));
  const iso = date.toISOString();
  return value % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// Hojas visibles de un .xlsx, en orden, como filas de celdas de texto.
export function readXlsx(buffer) {
  const files = readZip(buffer);
  const workbook = entry(files, 'xl/workbook.xml');
  if (!workbook) throw new Error('Archivo Excel sin xl/workbook.xml');
  const rels = entry(files, 'xl/_rels/workbook.xml.rels') || '';
  const targets = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .map((rel) => [rel.Id, rel.Target]));

  const sharedXml = entry(files, 'xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1], 't'));
  const dateStyles = dateStyleIndexes(entry(files, 'xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook);

  const sheets = [];
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const sheet = attributes(tag);
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
    const target = targets[sheet['r:id']];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = entry(files, path);
    if (!xml) continue;

    const rows = [];
    // Las filas vacías con formato vienen autocerradas (<row r="3" ht="20"/>).
    for (const [, , rowBody] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!rowBody) continue;
      const row = [];
      for (const [, cellAttrs, cellBody = ''] of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cell = attributes(cellAttrs);
        const index = columnIndex(cell.r) ?? row.length;
        const value = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1];
        let text = '';
        if (cell.t === 's') text = shared[Number(value)] ?? '';
        else if (cell.t === 'inlineStr') text = textRuns(cellBody, 't');
        else if (cell.t === 'b') text = value === '1' ? 'VERDADERO' : 'FALSO';
        else if (value !== undefined && cell.t !== 'str' && dateStyles.has(Number(cell.s))) text = excelSerialToIso(value, { date1904 });
        else if (value !== undefined) text = decodeXml(value);
        row[index] = text.trim();
      }
      rows.push(Array.from(row, (value) => value ?? ''));
    }
    const filled = rows.filter((row) => row.some((value) => value !== ''));
    if (filled.length) sheets.push({ name: sheet.name, rows: filled });
  }
  return sheets;
}

const escapeCell = (value) => String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function rowsToMarkdownTable(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? ''));
  const [header, ...body] = rows.map(pad);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => ':---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

// Markdown de todas las hojas visibles: una tabla por hoja, con su nombre.
export function xlsxToMarkdown(buffer) {
  const sheets = readXlsx(buffer);
  return sheets.map((sheet) => `### Hoja: ${sheet.name}\n\n${rowsToMarkdownTable(sheet.rows)}`).join('\n\n');
}

// Texto de un .pptx en orden de diapositivas, un párrafo por línea.
export function pptxToText(buffer) {
  const files = readZip(buffer);
  const slides = Object.keys(files)
    .map((path) => [path, /^ppt\/slides\/slide(\d+)\.xml$/.exec(path)?.[1]])
    .filter(([, number]) => number)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (!slides.length) throw new Error('Archivo PowerPoint sin diapositivas');
  return slides.map(([path, number]) => {
    const xml = entry(files, path);
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((match) => textRuns(match[1], 'a:t').trim())
      .filter(Boolean);
    return `## Diapositiva ${number}\n\n${paragraphs.join('\n')}`;
  }).join('\n\n');
}
