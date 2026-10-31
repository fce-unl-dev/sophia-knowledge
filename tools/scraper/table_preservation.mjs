// Las tablas no vuelven a pasar por el modelo.
//
// El formateo con Gemini entraba en bucle reescribiendo tablas markdown: en la
// corrida del 31/10/2026 las correlatividades de Contador Público 2027 (CP 482)
// llegaron al tope de salida con 1.192 caracteres útiles, porque el resto eran
// guiones de separadores repetidos. Además, la regla de "resumir tablas
// gigantes" dejaba a Luca sin las correlatividades exactas.
//
// Ahora cada tabla de la transcripción se reemplaza por un marcador antes de
// formatear, el modelo solo ordena el texto y copia el marcador, y la tabla
// vuelve tal cual se transcribió. Si el modelo pierde, duplica o inventa un
// marcador, el documento no entra.

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
// Acepta el marcador aunque el modelo lo envuelva en negrita o código.
const MARKER = /\*{0,2}`?\[\[TABLA_(\d+)\]\]`?\*{0,2}/g;

export const tableMarker = (index) => `[[TABLA_${index}]]`;

// Cantidad de columnas de una fila markdown (las barras escapadas no cuentan).
const columnCount = (line) => line.trim().replace(/\\\|/g, '').replace(/^\||\|$/g, '').split('|').length;
const normalizeRow = (line) => line.replace(/\s+/g, ' ').trim().toLowerCase();

// Une los tramos de páginas transcriptos por separado. Si un tramo termina en
// una tabla y el siguiente empieza con filas de la misma cantidad de columnas,
// es la misma tabla cortada por el tramo: el siguiente trae como "encabezado"
// su primera fila de datos, o repite el encabezado real, más un separador.
// Caso real: CP 482 (31/10/2026) quedó partida en tres tablas.
export function joinTranscribedChunks(chunks) {
  let joined = '';
  for (const chunk of chunks.map((text) => String(text ?? '').trim()).filter(Boolean)) {
    if (!joined) {
      joined = chunk;
      continue;
    }
    const previous = joined.split('\n');
    const next = chunk.split('\n');
    const lastRow = previous.at(-1);
    if (TABLE_LINE.test(lastRow) && TABLE_LINE.test(next[0]) && columnCount(lastRow) === columnCount(next[0])) {
      let start = previous.length - 1;
      while (start > 0 && TABLE_LINE.test(previous[start - 1])) start--;
      const header = previous[start];
      let rest = next;
      if (SEPARATOR_LINE.test(next[1] ?? '')) {
        rest = normalizeRow(next[0]) === normalizeRow(header) ? next.slice(2) : [next[0], ...next.slice(2)];
      }
      joined = [...previous, ...rest].join('\n');
    } else {
      joined = `${joined}\n\n${chunk}`;
    }
  }
  return joined;
}

// Reemplaza cada tabla markdown (encabezado + separador + filas) por un marcador.
// `sanitize` limpia cada tabla guardada (p. ej. colapsar separadores gigantes).
export function protectTables(text, { sanitize = (table) => table } = {}) {
  const lines = String(text ?? '').split('\n');
  const output = [];
  const tables = [];
  for (let index = 0; index < lines.length;) {
    if (TABLE_LINE.test(lines[index]) && SEPARATOR_LINE.test(lines[index + 1] ?? '')) {
      let end = index + 2;
      while (end < lines.length && TABLE_LINE.test(lines[end])) end++;
      tables.push(sanitize(lines.slice(index, end).join('\n')));
      output.push('', tableMarker(tables.length), '');
      index = end;
    } else {
      output.push(lines[index]);
      index++;
    }
  }
  return { text: output.join('\n').replace(/\n{3,}/g, '\n\n'), tables };
}

// Reinserta las tablas. Cada marcador tiene que aparecer exactamente una vez.
export function restoreTables(formatted, tables) {
  const seen = new Map();
  for (const [, number] of String(formatted).matchAll(MARKER)) seen.set(Number(number), (seen.get(Number(number)) || 0) + 1);
  const missing = tables.map((_, index) => index + 1).filter((number) => !seen.has(number));
  const duplicated = [...seen].filter(([number, count]) => number <= tables.length && count > 1).map(([number]) => number);
  const unknown = [...seen.keys()].filter((number) => number < 1 || number > tables.length);
  const text = String(formatted).replace(MARKER, (_match, number) => tables[Number(number) - 1] ?? _match);
  return { text, missing, duplicated, unknown };
}

export function checkRestoredTables({ missing, duplicated, unknown }, { label = 'este documento' } = {}) {
  if (!missing.length && !duplicated.length && !unknown.length) return null;
  const parts = [
    missing.length && `faltan ${missing.map(tableMarker).join(', ')}`,
    duplicated.length && `se repiten ${duplicated.map(tableMarker).join(', ')}`,
    unknown.length && `aparecen marcadores inexistentes ${unknown.map(tableMarker).join(', ')}`,
  ].filter(Boolean);
  return {
    status: 'lost-tables',
    reason: `el formateo de ${label} no conservó las tablas: ${parts.join('; ')}. El documento quedaría con tablas perdidas.`,
  };
}

// Señales de una transcripción alucinada en las tablas. Caso real: LA 484
// (31/10/2026) entró con la tabla de correlatividades repetida, las materias
// 12 a 27 ausentes y una tabla inventada "| Rank | Word |" con "the", "be",
// "to"... Todas eran tablas bien formadas: ninguna otra guarda lo detectaba.
const ENGLISH_FUNCTION_WORDS = /\b(the|be|to|of|and|that|have|it|for|not|on|with|you|this|but|his|by|from|they|we|say|her|she|what|which|would|there|their)\b/gi;

function tableRows(text) {
  return String(text ?? '').split('\n').filter((line) => TABLE_LINE.test(line) && !SEPARATOR_LINE.test(line));
}

function rowCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

export function checkTranscriptionSanity(text, { label = 'este documento' } = {}) {
  const rows = tableRows(text);
  const englishWords = new Set([...rows.join(' ').matchAll(ENGLISH_FUNCTION_WORDS)].map((match) => match[1].toLowerCase()));
  if (englishWords.size >= 8) {
    return {
      status: 'hallucinated-table',
      reason: `la transcripción de ${label} trae tablas con texto en inglés que no está en el original (${[...englishWords].slice(0, 6).join(', ')}…). El modelo inventó contenido.`,
    };
  }

  // Filas repetidas no alcanzan como señal: un plan de estudios repite con
  // razón las materias del ciclo básico en la tabla del título final.

  // Numeración de filas (materias 1..N) con huecos grandes.
  const numbers = rows.map((row) => /^\**\s*(\d{1,3})\b/.exec(rowCells(row)[0])?.[1]).filter(Boolean).map(Number);
  const max = numbers.length ? Math.max(...numbers) : 0;
  if (max >= 10 && max <= 150) {
    const present = new Set(numbers);
    const missing = [];
    for (let number = 1; number <= max; number++) if (!present.has(number)) missing.push(number);
    if (missing.length / max > 0.25) {
      return {
        status: 'numbering-gaps',
        reason: `la transcripción de ${label} numera filas hasta ${max} pero faltan ${missing.length} (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}). Se perdió parte de la tabla.`,
      };
    }
  }
  return null;
}

// Identificadores que no pueden perderse al formatear: números de resolución u
// ordenanza y mails institucionales. Los expedientes no cuentan: son datos
// administrativos que el formateo puede omitir con razón y que ya figuran en
// el nombre del archivo (falso positivo en CP 482, 31/10/2026).
const IDENTIFIER_PATTERNS = [
  /(?:res(?:oluci[oó]n)?|ordenanza|n\.?\s?[º°o]|c\.\s?[sd]\.?)\.?\s*(?:n\.?\s?[º°o]\.?\s*)?(\d{1,4}\/\d{2,4})(?![\d/])/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
];

// "755/26" sigue presente si el resultado dice "755/2026" o "Res. 755":
// alcanza con el número propio, sin otros dígitos pegados.
function identifierPresent(identifier, output) {
  if (output.includes(identifier)) return true;
  const number = /^(\d{1,4})\/\d{2,4}$/.exec(identifier)?.[1];
  return Boolean(number) && new RegExp(`(?<![\\d/])${number}(?!\\d)`).test(output);
}

export function extractIdentifiers(text) {
  const found = new Set();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of String(text ?? '').matchAll(pattern)) found.add((match[1] || match[0]).toLowerCase());
  }
  return found;
}

// Si se pierde más de un cuarto de los identificadores del original (con al
// menos tres para que el porcentaje signifique algo), el formateo resumió de más.
export function checkIdentifiers(sourceText, outputText, { minIdentifiers = 3, maxMissingRatio = 0.25, label = 'este documento' } = {}) {
  const source = extractIdentifiers(sourceText);
  if (source.size < minIdentifiers) return null;
  const output = String(outputText ?? '').toLowerCase();
  const missing = [...source].filter((identifier) => !identifierPresent(identifier, output));
  if (missing.length / source.size <= maxMissingRatio) return null;
  return {
    status: 'lost-identifiers',
    reason: `el formateo de ${label} perdió ${missing.length} de ${source.size} identificadores del original (${missing.slice(0, 5).join(', ')}). Probablemente resumió contenido que debía transcribir.`,
    missing,
  };
}
