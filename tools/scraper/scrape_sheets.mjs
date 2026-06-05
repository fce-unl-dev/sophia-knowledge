import { createHash } from 'node:crypto';

// Descarga una pestaña específica de una Google Sheet pública como CSV
export async function fetchSheetAsCsv(spreadsheetId, gid, fetchImpl = fetch) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Error descargando Google Sheet (${response.status} ${response.statusText}) desde ${url}`);
  }
  return await response.text();
}

// Parser CSV robusto compatible con RFC 4180
export function parseCsv(text) {
  const lines = [];
  let row = [];
  let curVal = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          curVal += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        curVal += c;
        i++;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
        i++;
      } else if (c === ',') {
        row.push(curVal);
        curVal = '';
        i++;
      } else if (c === '\r' || c === '\n') {
        row.push(curVal);
        curVal = '';
        lines.push(row);
        row = [];
        if (c === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i += 2;
        } else {
          i++;
        }
      } else {
        curVal += c;
        i++;
      }
    }
  }
  if (curVal || row.length > 0) {
    row.push(curVal);
    lines.push(row);
  }
  return lines;
}

// Parsea el CSV irregular de exámenes finales
export function parseExamCsv(csvContent, turnName) {
  const rows = parseCsv(csvContent);
  const exams = [];
  
  let currentDay = '';
  let currentDate = '';
  let currentInscripcion = '';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].map(cell => (cell || '').trim());
    if (row.length === 0 || row.every(cell => cell === '')) {
      continue;
    }

    // 1. Detectar si es una fila de fecha/día de examen
    // Ejemplo: col 0 = "Miércoles", col 1 = "29/4/2026" o col 0 = "Fecha Examen"
    const col0 = row[0] || '';
    const col1 = row[1] || '';
    
    if (col0.toLowerCase() === 'fecha examen') {
      continue; // es la fila cabecera
    }

    // Un día válido suele ser Lunes, Martes, Miércoles, Jueves, Viernes, Sábado
    const diasSemana = ['lunes', 'martes', 'miércoles', 'miercoles', 'jueves', 'viernes', 'sábado', 'sabado'];
    const esDia = diasSemana.includes(col0.toLowerCase());
    const esFecha = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(col1);

    if (esDia && esFecha) {
      currentDay = col0;
      currentDate = col1;
      continue;
    }

    // 2. Detectar fila de inscripción
    // Ejemplo: col 0 = "Desde el", col 1 = "22/4/2026", col 2 = "al", col 3 = "27/4/2026"
    // O col 0 = "Inscripción"
    if (col0.toLowerCase() === 'inscripción' || col0.toLowerCase() === 'inscripcion') {
      continue; // cabecera de inscripción
    }

    if (col0.toLowerCase() === 'desde el' && row[2]?.toLowerCase() === 'al') {
      currentInscripcion = `Desde el ${row[1]} al ${row[3]}`;
    }

    // 3. Detectar materia
    // Las columnas relevantes para la materia son:
    // col 4: Código (ej. 3160, 1015, FCE5145)
    // col 5: Actividad/Materia (ej. Habilitante de Sociedades)
    // col 6: Hora (ej. 09:00 Hs)
    const code = row[4] || '';
    const name = row[5] || '';
    const time = row[6] || '';

    if (code && name) {
      exams.push({
        turno: turnName,
        dia: currentDay,
        fecha: currentDate,
        inscripcion: currentInscripcion,
        codigo: code,
        materia: name,
        hora: time
      });
    }
  }

  return exams;
}

// Limpia y normaliza el nombre de la materia
function cleanSubjectName(name) {
  if (!name) return '';
  return name
    .replace(/[\r\n]+/g, ' ') // reemplazar saltos de línea con espacios
    .replace(/[“”"']/g, '')   // remover comillas raras
    .replace(/^[-\s]+/, '')    // remover guiones o espacios iniciales
    .replace(/\s+/g, ' ')     // normalizar múltiples espacios
    .trim();
}

// Parsea el CSV de horarios de clases
export function parseScheduleCsv(csvContent, yearName) {
  const rows = parseCsv(csvContent);
  if (rows.length === 0) return [];

  const cleanYearName = (yearName || '').trim().toLowerCase();

  // 1. Manejo especial de "Optativas"
  if (cleanYearName === 'optativas' || (rows[0] && rows[0].some(cell => (cell || '').trim().toLowerCase() === 'nombre de materia'))) {
    return parseOptativasCsv(rows, yearName);
  }

  // 2. Manejo especial de "Inglés" u otras que no tengan cabeceras explícitas de comisiones
  // pero que tengan comisiones reales (ej. "Com. N° 1") en la columna 0.
  let hasComisionesHeader = false;
  let headerRowIndex = -1;
  let subjectRowIndex = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.some(cell => (cell || '').trim().toLowerCase().startsWith('comision'))) {
      headerRowIndex = i;
      subjectRowIndex = Math.max(0, i - 2);
      hasComisionesHeader = true;
      break;
    }
  }

  if (!hasComisionesHeader) {
    // Si no tiene cabeceras pero tiene comisiones en la fila 3 (ej. Inglés)
    // Busquemos una fila que empiece con "Com. N°" o "Com. 1"
    let firstComisionRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const cell0 = (rows[i][0] || '').trim();
      if (/^com\.?\s*(n°|nº)?\s*\d+/i.test(cell0)) {
        firstComisionRow = i;
        break;
      }
    }

    if (firstComisionRow !== -1) {
      // Intentamos inferir la materia en las filas superiores (típicamente fila 1 col 0)
      let inferredSubject = 'Materia sin nombre';
      for (let r = 0; r < firstComisionRow; r++) {
        const val = (rows[r][0] || '').trim();
        if (val && !val.startsWith('"') && val.length > 5) {
          inferredSubject = val;
          break;
        }
      }

      // Estructuramos un bloque por defecto de 4 columnas en col 0
      const blocks = [{
        startIndex: 0,
        subject: cleanSubjectName(inferredSubject),
        lastComision: '',
        lastDocente: ''
      }];

      const scheduleEntries = [];
      for (let i = firstComisionRow; i < rows.length; i++) {
        const row = rows[i].map(cell => (cell || '').trim());
        if (row.length === 0 || row.every(cell => cell === '')) continue;
        
        // Evitar líneas informativas como "80% de asistencia obligatoria"
        if (row[0] && !/^com\.?\s*(n°|nº)?\s*\d+/i.test(row[0]) && !row[1] && !row[2]) {
          continue;
        }

        const block = blocks[0];
        const comision = row[0];
        const dia = row[1];
        const horario = row[2];
        const docente = row[3];

        if (comision) block.lastComision = comision;
        if (docente) block.lastDocente = docente;

        if (dia || horario) {
          scheduleEntries.push({
            anio: yearName,
            materia: block.subject,
            comision: block.lastComision || 'N/D',
            dia: dia || 'N/D',
            horario: horario || 'N/D',
            docente: block.lastDocente || 'N/D'
          });
        }
      }
      return scheduleEntries;
    }
    
    return [];
  }

  // 3. Estructura estándar con cabecera "Comisiones"
  const subjectRow = rows[subjectRowIndex].map(cell => (cell || '').trim());
  const headerRow = rows[headerRowIndex].map(cell => (cell || '').trim());

  // Detectar bloques dinámicamente
  const blocks = [];
  for (let c = 0; c < headerRow.length; c++) {
    const colName = headerRow[c].toLowerCase();
    if (colName.startsWith('comision')) {
      let subjectName = '';
      for (let offset = 0; offset < 5; offset++) {
        if (subjectRow[c + offset]) {
          subjectName = subjectRow[c + offset];
          break;
        }
      }
      blocks.push({
        startIndex: c,
        subject: cleanSubjectName(subjectName) || 'Materia sin nombre',
        lastComision: '',
        lastDocente: ''
      });
    }
  }

  const scheduleEntries = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i].map(cell => (cell || '').trim());
    if (row.length === 0 || row.every(cell => cell === '')) {
      continue;
    }

    for (const block of blocks) {
      const c = block.startIndex;
      if (c >= row.length) continue;

      const comision = row[c];
      const dia = row[c + 1];
      const horario = row[c + 2];
      const docente = row[c + 3];

      if (!comision && !dia && !horario && !docente) {
        continue;
      }

      if (comision) {
        block.lastComision = comision;
      }
      if (docente) {
        block.lastDocente = docente;
      }

      if (dia || horario) {
        scheduleEntries.push({
          anio: yearName,
          materia: block.subject,
          comision: block.lastComision || 'N/D',
          dia: dia || 'N/D',
          horario: horario || 'N/D',
          docente: block.lastDocente || 'N/D'
        });
      }
    }
  }

  return scheduleEntries;
}

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'miercoles', 'jueves', 'viernes', 'sábado', 'sabado', 'domingo'];

// Separa "Lunes 8 hs" → { dia: 'Lunes', horario: '8 hs' }. Si no arranca con
// un día de semana, deja el texto completo como horario.
function splitDiaHorario(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { dia: 'N/D', horario: 'N/D' };
  const [first, ...rest] = clean.split(' ');
  if (DIAS_SEMANA.includes(first.toLowerCase())) {
    return { dia: first, horario: rest.join(' ').trim() || 'N/D' };
  }
  return { dia: 'N/D', horario: clean };
}

// Parser DEFENSIVO de comisiones embebidas en el texto libre de horarios de
// optativas. Solo separa cuando hay un patrón inequívoco de >=2 comisiones
// "Cn: <horario> [Profesor/a Nombre]" (ej. Liderazgo de las organizaciones
// complejas). Si el patrón no aparece, devuelve [] y el llamador deja la
// optativa como una sola entry (comportamiento original, sin riesgo).
export function parseComisionesFromText(text) {
  if (!text) return [];
  const normalized = String(text).replace(/<br\s*\/?>/gi, '\n');
  const matches = [...normalized.matchAll(/C\s*(\d+)\s*:\s*([\s\S]*?)(?=C\s*\d+\s*:|$)/g)];
  if (matches.length < 2) return []; // necesita al menos 2 comisiones explícitas

  const docenteRe = /\b(?:Profesor(?:a|es|as)?|Prof\.?|Docentes?|a cargo de)\s+(.+)$/i;
  const result = [];
  for (const m of matches) {
    const comision = `C${m[1]}`;
    let rest = m[2].replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '').trim();
    let docente = '';
    const dm = rest.match(docenteRe);
    if (dm) {
      docente = dm[1].replace(/[.;]+$/, '').trim();
      rest = rest.slice(0, dm.index).trim();
    }
    const { dia, horario } = splitDiaHorario(rest);
    result.push({ comision, dia, horario, docente });
  }
  return result;
}

// Función auxiliar para parsear Optativas
function parseOptativasCsv(rows, yearName) {
  const header = rows[0].map(cell => (cell || '').trim().toLowerCase());
  
  // Buscar índices de las columnas clave
  const subjectIdx = header.findIndex(h => h.includes('materia') || h.includes('nombre'));
  const docIdx = header.findIndex(h => h.includes('docente'));
  const scheduleIdx = header.findIndex(h => h.includes('horario') || h.includes('dia'));

  if (subjectIdx === -1) return [];

  const scheduleEntries = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].map(cell => (cell || '').trim());
    if (row.length === 0 || row.every(cell => cell === '')) continue;

    const subject = row[subjectIdx];
    if (!subject) continue;

    const docente = docIdx !== -1 ? row[docIdx] : 'N/D';
    const horario = scheduleIdx !== -1 ? row[scheduleIdx] : 'N/D';
    const materia = cleanSubjectName(subject);

    // Si el horario trae varias comisiones explícitas (Cn: ... Prof X),
    // las desdoblamos en una entry limpia por comisión. Cada comisión usa
    // su docente embebido; si no lo tiene, cae al docente de la columna.
    const comisiones = parseComisionesFromText(horario);
    if (comisiones.length > 0) {
      for (const com of comisiones) {
        scheduleEntries.push({
          anio: yearName,
          materia,
          comision: com.comision,
          dia: com.dia,
          horario: com.horario,
          docente: com.docente || docente || 'N/D',
        });
      }
      continue;
    }

    scheduleEntries.push({
      anio: yearName,
      materia,
      comision: 'Única',
      dia: 'Ver horarios',
      horario: horario,
      docente: docente
    });
  }

  return scheduleEntries;
}

// Orquestador para descargar y parsear todos los turnos de exámenes
export async function fetchExamSchedules(fetchImpl = fetch) {
  const spreadsheetId = '1WTtJSCfU2lnsKjzCU5QoTQ59sAIt-y2Xgq2_dHAeBAw';
  const turns = [
    { name: 'Primer turno 2026', gid: '0' },
    { name: 'Segundo turno 2026', gid: '1846442018' },
    { name: 'Tercer turno 2026', gid: '365503432' },
    { name: 'Cuarto turno 2026', gid: '1845283118' },
    { name: 'Quinto turno 2026', gid: '285505131' },
    { name: 'Sexto turno 2026', gid: '1441565014' },
    { name: 'Séptimo turno 2026', gid: '1500326917' },
    { name: 'Octavo turno 2026', gid: '594841940' }
  ];

  const allExams = [];
  for (const turn of turns) {
    try {
      const csv = await fetchSheetAsCsv(spreadsheetId, turn.gid, fetchImpl);
      const parsed = parseExamCsv(csv, turn.name);
      allExams.push({ turn: turn.name, exams: parsed, ok: true });
    } catch (err) {
      allExams.push({ turn: turn.name, exams: [], ok: false, error: err.message });
    }
  }
  return allExams;
}

// Orquestador para descargar y parsear los horarios de comisiones
export async function fetchClassSchedules(fetchImpl = fetch) {
  const spreadsheetId = '1p7K1Ht27ZxnqUoYN2bCqsaUP8WvQKP7AhRLo5SDIddo';
  const tabs = [
    { name: 'Ingresantes', gid: '1427546763' },
    { name: 'Primer año (ingresos 2025 y anteriores)', gid: '199298076' },
    { name: 'Segundo año', gid: '832130844' },
    { name: 'Tercer año', gid: '1669157735' },
    { name: 'Cuarto año', gid: '1169212956' },
    { name: 'Quinto año', gid: '1975286904' },
    { name: 'Inglés', gid: '1356447574' },
    { name: 'Optativas', gid: '190436360' }
  ];

  const allSchedules = [];
  for (const tab of tabs) {
    try {
      const csv = await fetchSheetAsCsv(spreadsheetId, tab.gid, fetchImpl);
      const parsed = parseScheduleCsv(csv, tab.name);
      allSchedules.push({ tab: tab.name, schedules: parsed, ok: true });
    } catch (err) {
      allSchedules.push({ tab: tab.name, schedules: [], ok: false, error: err.message });
    }
  }
  return allSchedules;
}

// Genera tabla Markdown para exámenes
export function generateExamsMarkdownTable(exams) {
  if (!exams || exams.length === 0) return '_No hay exámenes programados registrados en la planilla._';
  
  const headers = ['Fecha', 'Día', 'Código', 'Materia', 'Hora', 'Inscripción'];
  const separator = [':---', ':---', ':---', ':---', ':---', ':---'];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`
  ];

  for (const exam of exams) {
    const row = [
      exam.fecha || '-',
      exam.dia || '-',
      exam.codigo || '-',
      exam.materia || '-',
      exam.hora || '-',
      exam.inscripcion || '-'
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

// Genera tablas Markdown para horarios, agrupadas por materia
export function generateSchedulesMarkdownTables(schedules) {
  if (!schedules || schedules.length === 0) return '_No hay horarios registrados en la planilla._';

  // Agrupar por materia
  const bySubject = {};
  for (const entry of schedules) {
    if (!bySubject[entry.materia]) {
      bySubject[entry.materia] = [];
    }
    bySubject[entry.materia].push(entry);
  }

  const sections = [];
  for (const [subject, entries] of Object.entries(bySubject)) {
    sections.push(`#### ${subject}`);
    sections.push('');
    
    const headers = ['Comisión', 'Día', 'Horario', 'Docente'];
    const separator = [':---', ':---', ':---', ':---'];
    const tableLines = [
      `| ${headers.join(' | ')} |`,
      `| ${separator.join(' | ')} |`
    ];

    for (const entry of entries) {
      tableLines.push(`| ${entry.comision} | ${entry.dia} | ${entry.horario} | ${entry.docente.replace(/\n/g, '<br>')} |`);
    }
    sections.push(tableLines.join('\n'));
    sections.push('');
  }

  return sections.join('\n');
}

// Separa una celda de docente que puede contener varios nombres.
// La planilla usa saltos de línea o <br> para separar co-docentes
// (ej. "Claudia Zanabria<br> Lujan Alvarez"). NO separamos por coma
// para no romper nombres en formato "Apellido, Nombre".
export function splitDocentes(raw) {
  if (!raw) return [];
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/[\n;]+/)
    .map((name) => name.replace(/^[-\s]+/, '').trim()) // limpia guiones iniciales de la planilla
    .filter((name) => name && name.toUpperCase() !== 'N/D');
}

// Saneo de celda para tabla Markdown: colapsa saltos de línea y escapa
// pipes, para que un dato sucio de la planilla (ej. optativas con varias
// comisiones en una celda) no rompa la tabla partiéndola en filas.
function sanitizeCell(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim() || 'N/D';
}

// Títulos académicos/honoríficos que la planilla antepone de forma inconsistente
// ("Dra. PACIFICO, Andrea" vs "Andrea, Pacifico"). Se descartan para la clave de
// agrupación: NO forman parte de la identidad del docente. En minúsculas y sin
// puntuación, igual que los tokens contra los que se comparan.
const TEACHER_TITLES = new Set([
  'dr', 'dra', 'dres', 'lic', 'mg', 'mgtr', 'esp', 'cr', 'cra', 'cp', 'cpn',
  'c', 'p', 'n', 'prof', 'ing', 'arq', 'ph', 'phd', 'msc',
]);

// Clave de agrupación CANÓNICA para un docente. El mismo docente aparece en las
// planillas con formatos incompatibles (orden Nombre/Apellido invertido, con o sin
// coma, en mayúsculas, con título antepuesto). Para que el "Índice por Docente" no
// lo fragmente en varias entradas, la clave normaliza agresivamente:
//   1. minúsculas + sin tildes
//   2. puntuación (. , /) → espacio
//   3. descarta títulos académicos (Dr./Dra./Lic./Mg./...)
//   4. token-set ORDENADO: ordena los nombres alfabéticamente y deduplica, de modo
//      que "andrea pacifico" === "pacifico andrea". El orden Nombre/Apellido deja de importar.
// Solo se usa para agrupar/deduplicar, nunca para mostrar (se muestra el nombre
// tal cual su primera aparición). Token-set EXACTO: no hace fuzzy matching, así que
// typos en la fuente ("Barreta" vs "Barretta") y subconjuntos ("Rut Azerrad" vs
// "María Rut Azerrad") quedan separados a propósito — preferimos no fusionar de más.
export function normalizeTeacherKey(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // diacríticos
    .replace(/[.,/]/g, ' ')   // puntuación que separa apellido/nombre o título
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(' ')
    .filter((t) => t && !TEACHER_TITLES.has(t));
  if (tokens.length === 0) return '';
  return [...new Set(tokens)].sort().join(' ');
}

// Combina día y horario en una sola celda legible. En optativas el día
// suele venir como "Ver horarios" (placeholder), así que mostramos solo
// el horario cuando el día no aporta información.
function formatDiaHorario(dia, horario) {
  const d = (dia || '').trim();
  const h = (horario || '').trim();
  const diaUtil = d && !/^ver horarios$/i.test(d) && d.toUpperCase() !== 'N/D';
  const horaUtil = h && h.toUpperCase() !== 'N/D';
  if (diaUtil && horaUtil) return `${d} — ${h}`;
  if (diaUtil) return d;
  if (horaUtil) return h;
  return 'N/D';
}

// Genera un índice inverso Docente → Materias a partir de TODAS las
// pestañas de horarios. Resuelve el patrón de consulta "¿qué materia
// dicta X?" / "soy docente, ¿qué doy?", que falla cuando el modelo tiene
// que escanear tablas organizadas por materia. Acepta el formato de
// fetchClassSchedules: [{ tab, schedules, ok }].
export function generateScheduleByTeacherTable(allSchedules) {
  if (!allSchedules || allSchedules.length === 0) {
    return '_No hay horarios registrados en la planilla._';
  }

  // Agrupar filas por docente normalizado, preservando el nombre original.
  const byTeacher = new Map();
  for (const tab of allSchedules) {
    if (!tab || tab.ok === false || !Array.isArray(tab.schedules)) continue;
    for (const entry of tab.schedules) {
      for (const docente of splitDocentes(entry.docente)) {
        const key = normalizeTeacherKey(docente);
        if (!key) continue;
        if (!byTeacher.has(key)) {
          byTeacher.set(key, { display: docente, rows: [] });
        }
        byTeacher.get(key).rows.push({
          materia: sanitizeCell(entry.materia),
          comision: sanitizeCell(entry.comision),
          diaHorario: sanitizeCell(formatDiaHorario(entry.dia, entry.horario)),
        });
      }
    }
  }

  if (byTeacher.size === 0) {
    return '_No hay docentes registrados en la planilla._';
  }

  // Ordenar docentes alfabéticamente por su clave normalizada.
  const teachers = [...byTeacher.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));

  const headers = ['Docente', 'Materia', 'Comisión', 'Día y Horario'];
  const separator = [':---', ':---', ':---', ':---'];
  const tableLines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
  ];

  for (const [, { display, rows }] of teachers) {
    // Deduplicar filas idénticas (materia+comisión+día/horario) del mismo docente.
    const seen = new Set();
    for (const row of rows) {
      const dedupeKey = `${row.materia}||${row.comision}||${row.diaHorario}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tableLines.push(`| ${display} | ${row.materia} | ${row.comision} | ${row.diaHorario} |`);
    }
  }

  return tableLines.join('\n');
}
