import { google } from 'googleapis';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { parseCsv } from './scrape_sheets.mjs';
import { callGemini, stripMarkdownFence } from './generate_md.mjs';
import { resolveSectorFromDrivePath, parseSectorResponse, SECTOR_NAMES } from './generate_routing_metadata.mjs';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

// Setup directories
const here = dirname(fileURLToPath(import.meta.url));
const defaultStateDir = resolve(here, 'state/complementos');
const defaultKbRoot = resolve(here, '../..');

// Helper to calculate sha256 hash of a string or buffer
function getSha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Slugify string helper
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Stop words and keywords logic
const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'y', 'e', 'o', 'u', 'en', 'para', 'por', 'con',
  'sin', 'sobre', 'bajo', 'entre', 'hacia', 'desde', 'hasta',
  'a', 'al', 'doc', 'docx', 'pdf', 'txt', 'csv', 'xls', 'xlsx',
  'que', 'se', 'su', 'sus', 'este', 'esta', 'estos', 'estas',
  'como', 'mas', 'pero', 'o', 'u', 'y', 'con'
]);

function getKeywords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Find potential duplicates
async function findPotentialDuplicates(fileName, fileFolder, indexItems, kbRoot) {
  const fileKeywords = getKeywords(`${fileFolder} ${fileName.replace(/\.[a-z0-9]+$/i, '')}`);
  if (fileKeywords.length === 0) return [];

  const candidates = [];
  for (const item of indexItems) {
    if (!item.path || !item.title) continue;
    if (item.path.startsWith('complementos/')) continue;

    const itemKeywords = getKeywords(`${item.path} ${item.title}`);
    let overlapCount = 0;
    for (const kw of fileKeywords) {
      if (itemKeywords.includes(kw)) {
        overlapCount++;
      }
    }

    if (overlapCount > 0) {
      candidates.push({
        item,
        score: overlapCount,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const topMatches = candidates.slice(0, 3).map(c => c.item);

  const results = [];
  for (const item of topMatches) {
    const fullPath = join(kbRoot, item.path);
    if (existsSync(fullPath)) {
      try {
        const content = await readFile(fullPath, 'utf8');
        results.push({
          path: item.path,
          title: item.title,
          content,
        });
      } catch (err) {
        console.warn(`[Warning] No se pudo leer el archivo duplicado candidato ${fullPath}:`, err.message);
      }
    }
  }
  return results;
}

// Gemini duplicate check
const DEDUPLICATE_SYSTEM_PROMPT = `Sos un auditor de contenido para la base de conocimientos de Sophia.
Tu tarea es comparar el texto extraído de un nuevo documento recibido desde Google Drive con el contenido de documentos existentes en la base de conocimientos (KB) para determinar si la información del nuevo documento ya está completamente cubierta (es un duplicado) o si aporta información nueva y complementaria.

Responde ÚNICAMENTE en formato JSON con la siguiente estructura (sin bloques de código markdown, solo el JSON crudo):
{
  "isDuplicate": boolean,
  "similarityRatio": number,
  "explanation": "explicación en español de por qué es o no duplicado",
  "hasComplementaryInfo": boolean,
  "newKeyDetails": "detalles específicos nuevos si los hay, de lo contrario vacío"
}

Reglas:
1. "isDuplicate" debe ser true solo si TODA la información importante del nuevo documento ya existe en el documento del KB.
2. Si el nuevo documento contiene datos nuevos (como fechas específicas de este año, nuevos links, nuevos nombres de docentes, o nuevos procedimientos) que no están en el KB actual, "hasComplementaryInfo" debe ser true y "isDuplicate" debe ser false. De todos modos, si hay información complementaria útil no presente, queremos guardarlo como complemento, por lo que "isDuplicate" debería ser false.
3. Sé estricto: no queremos llenar la KB con documentos redundantes, pero tampoco queremos perder información valiosa que no esté en la web pública.
`;

async function checkIsDuplicate(apiKey, fileName, extractedText, existingDocs, model) {
  if (existingDocs.length === 0) {
    return { isDuplicate: false, similarityRatio: 0, explanation: 'No existing documents for keyword match.' };
  }

  let existingDocsText = '';
  for (const doc of existingDocs) {
    existingDocsText += `\n--- Archivo: ${doc.path} (Título: ${doc.title}) ---\n${doc.content}\n`;
  }

  const userPrompt = `
NUEVO DOCUMENTO (de Google Drive):
Nombre: ${fileName}
Texto extraído:
${extractedText}

DOCUMENTOS EXISTENTES EN LA KB (posibles duplicados):
${existingDocsText}

TAREA:
Compara el nuevo documento con los existentes y responde en el formato JSON requerido.
`;

  try {
    const { text } = await callGemini({
      apiKey,
      systemInstruction: DEDUPLICATE_SYSTEM_PROMPT,
      userPrompt,
      model,
      temperature: 0.1,
    });
    
    const cleanedJson = stripMarkdownFence(text);
    return JSON.parse(cleanedJson);
  } catch (err) {
    console.error(`[Error] Error ejecutando chequeo de duplicados para ${fileName}:`, err.message);
    return {
      isDuplicate: false,
      similarityRatio: 0,
      explanation: `Error checking duplicates: ${err.message}`,
      hasComplementaryInfo: true,
    };
  }
}

// Fallback IA: cuando la carpeta de Drive no matchea ningún alias de la
// taxonomía, le pedimos a Gemini que elija el sector canónico más apropiado.
const SECTOR_CLASSIFY_SYSTEM_PROMPT = `Sos un clasificador de contenido para la base de conocimientos de Sophia, asistente virtual de la Facultad de Ciencias Económicas (FCE) de la UNL.
Un responsable de la facultad subió un documento a Google Drive. Tu tarea es elegir el SECTOR canónico al que pertenece, de la lista provista.
Respondé ÚNICAMENTE con JSON crudo (sin bloques markdown), con esta estructura:
{ "sector": "<id-del-sector>", "confidence": <número entre 0 y 1> }
Si ningún sector encaja claramente, devolvé el más cercano con confianza baja (< 0.6).`;

async function classifySectorWithGemini({ apiKey, drivePath, fileName, textSnippet, model }) {
  const sectorList = Object.entries(SECTOR_NAMES)
    .map(([id, name]) => `- ${id}: ${name}`)
    .join('\n');

  const userPrompt = `SECTORES DISPONIBLES (devolvé el id, no el nombre):
${sectorList}

DOCUMENTO A CLASIFICAR:
- Carpeta de Drive: ${drivePath}
- Nombre de archivo: ${fileName}
- Extracto del contenido:
${(textSnippet || '').slice(0, 2000)}

Elegí el sector más apropiado.`;

  try {
    const { text } = await callGemini({
      apiKey,
      systemInstruction: SECTOR_CLASSIFY_SYSTEM_PROMPT,
      userPrompt,
      model,
      temperature: 0.1,
    });
    return parseSectorResponse(text);
  } catch (err) {
    console.warn(`  [Sector] Fallback IA falló para ${fileName}: ${err.message}`);
    return undefined;
  }
}

// Colapsa runs anómalos de caracteres de relleno que algunos PDFs (vía Gemini)
// generan como separadores gigantes y que inflan la KB sin aportar contenido.
// Caso real: una fila separadora de tabla con ~214.000 guiones (~67K tokens) en
// una sola línea. Determinista y seguro: una fila separadora legítima usa 3
// guiones, así que colapsar runs de 4+ no rompe ninguna tabla ni contenido.
export function sanitizeKbMarkdown(md) {
  if (typeof md !== 'string' || !md) return md;
  return md
    .split('\n')
    .map((line) => line
      .replace(/:-{4,}/g, ':---')   // celda separadora de tabla alineada izq.
      .replace(/-{4,}/g, '---')     // runs de guiones (separadores/hr inflados)
      .replace(/={4,}/g, '===')     // runs de '='
      .replace(/_{4,}/g, '___')     // runs de '_'
      .replace(/ {80,}/g, ' '))     // relleno de espacios anómalo
    .join('\n');
}

// Convert CSV to Markdown table
function csvToMarkdownTable(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return '';
  const cleanRows = rows.map(r => r.map(c => (c || '').trim())).filter(r => r.length > 0 && r.some(c => c !== ''));
  if (cleanRows.length === 0) return '';
  
  const header = cleanRows[0];
  const separator = header.map(() => ':---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`
  ];
  for (let i = 1; i < cleanRows.length; i++) {
    lines.push(`| ${cleanRows[i].join(' | ')} |`);
  }
  return lines.join('\n');
}

// Format CSV deterministic complement
function formatCsvAsMarkdownComplement(fileName, fileId, modifiedTime, webViewLink, mdTable) {
  const title = fileName.replace(/\.csv$/i, '').replace(/\.xlsx?$/i, '');
  return `# ${title}

Planilla de datos complementarios extraída de Google Drive.

---

## Contenido

${mdTable}

---

## Metadatos del Documento

- **Origen**: Google Drive (\`${fileName}\`)
- **ID de Archivo**: \`${fileId}\`
- **Fecha de Modificación en Drive**: \`${modifiedTime}\`
- **Categoría**: Complemento Institucional

## Fuentes consultadas

- [${fileName}](${webViewLink})
`;
}

// Gemini formatting for text documents
const FORMAT_SYSTEM_PROMPT = `Sos el redactor del Knowledge Base de Sophia, asistente virtual oficial de la Facultad de Ciencias Económicas (FCE) de la UNL. Tu trabajo es formatear y estructurar un texto extraído de un documento de Google Drive en una ficha Markdown de complemento siguiendo la plantilla provista.

REGLAS DURAS:
1. Estructura: generá únicamente:
   - Título H1 al principio (debe comenzar con # {Título del Documento})
   - Párrafo introductorio de descripción corta
   - Línea divisoria '---'
   - Sección '## Contenido'
   NO incluyas las secciones de "Metadatos del Documento" ni "Fuentes consultadas" al final, ya que el sistema las agregará automáticamente de forma programática.
2. No inventes información: confórmate estrictamente al texto provisto. Si faltan datos, pon "No publicado" o similar, pero preserva todo el contenido real e importante.
3. Formato limpio: usa subtítulos (H3 o H4), listas viñetadas, negritas y tablas markdown para que el contenido sea legible.
4. Tono neutral y técnico: sin preámbulos, saludos, ni formalidades de redacción institucional.
5. Gestión de longitud: Si el documento original contiene tablas gigantes (con decenas/cientos de filas de datos repetitivos, como listas de correlatividades, materias) o es extremadamente extenso (más de 5,000 palabras), NO intentes transcribir toda la información o tablas de forma literal exhaustiva. En su lugar, realiza un resumen estructurado claro de las resoluciones, artículos clave o reglas de negocio principales, y proporciona una visión general sintética de las tablas. Nunca repitas cientos de filas de tablas, ya que excede los límites del modelo y causa truncamientos.
6. Devuelve ÚNICAMENTE el markdown estructurado de la sección de Contenido (H1, descripción, divisor, y ## Contenido), sin bloques de código markdown envolventes (\`\`\`markdown ... \`\`\`), sin notas al principio o al final.
`;

async function formatComplementWithGemini(apiKey, fileInfo, extractedText, templateContent, model) {
  // We pass a modified template to Gemini to show it where to stop
  const templateWithoutMetadata = templateContent.split('## Metadatos del Documento')[0].trim();

  const userPrompt = `
PLANTILLA DE COMPLEMENTO (generá solo hasta la sección ## Contenido inclusive):
${templateWithoutMetadata}

INFORMACIÓN DEL ARCHIVO:
- Nombre: ${fileInfo.name}
- ID de archivo: ${fileInfo.id}
- Fecha de modificación: ${fileInfo.modifiedTime}
- URL de Drive: ${fileInfo.webViewLink}

TEXTO EXTRAÍDO DEL DOCUMENTO:
${extractedText}

TAREA:
Generá el archivo markdown estructurado según la plantilla hasta la sección "## Contenido" inclusive. No agregues "## Metadatos del Documento" ni "## Fuentes consultadas". Devuelve solo el markdown listo para escribir a archivo.
`;

  const { text } = await callGemini({
    apiKey,
    systemInstruction: FORMAT_SYSTEM_PROMPT,
    userPrompt,
    model,
    temperature: 0.2,
  });

  return stripMarkdownFence(text);
}

// Prompt de extracción multimodal fiel. Gemini lee el PDF nativo (texto +
// tablas + imágenes), resolviendo el caso de tablas embebidas COMO IMAGEN que
// pdf-parse (solo texto) deja vacías — ej. el cuadro de correlatividades de la
// Res. 503 quedó sin filas porque venía escaneado.
const PDF_EXTRACTION_SYSTEM = 'Sos un extractor de texto fiel de documentos institucionales. Te paso un PDF. Devolvé TODO su contenido textual en texto plano o markdown, SIN resumir, interpretar ni omitir nada. Reproducí las TABLAS completas en markdown, con TODAS sus filas y columnas (incluí celdas vacías como "—"). No agregues comentarios tuyos: solo el contenido del documento.';

// Extrae el texto de un PDF. Estrategia multimodal-first: si hay apiKey, Gemini
// lee el PDF completo (incluye tablas como imagen); si no hay apiKey (dev/test)
// o el modelo falla, cae a pdf-parse (solo texto). Con temperatura 0 el output
// es estable entre corridas, así que el hash incremental sigue funcionando.
// Deps inyectables para test (callGeminiImpl, pdfParseImpl, logImpl).
export async function extractPdfText(buffer, {
  apiKey = null,
  model = 'gemini-2.5-flash',
  callGeminiImpl = callGemini,
  pdfParseImpl = pdf,
  logImpl = console,
} = {}) {
  let parsedText = '';
  try {
    const data = await pdfParseImpl(buffer);
    parsedText = (data?.text || '').trim();
  } catch (err) {
    logImpl.warn?.(`[PDF] pdf-parse falló: ${err.message}`);
  }

  if (!apiKey) return parsedText; // sin credenciales (dev/test) → solo pdf-parse

  try {
    const { text } = await callGeminiImpl({
      apiKey,
      model,
      systemInstruction: PDF_EXTRACTION_SYSTEM,
      userPrompt: 'Extraé el contenido completo de este PDF (texto y tablas) en markdown.',
      fileParts: [{ inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } }],
      temperature: 0,
    });
    const ocr = (text || '').trim();
    // Nos quedamos con el multimodal salvo que, por alguna anomalía, venga más
    // pobre que pdf-parse (en cuyo caso preservamos el texto plano).
    return ocr.length >= parsedText.length ? ocr : parsedText;
  } catch (err) {
    logImpl.warn?.(`[PDF] extracción multimodal falló, uso pdf-parse: ${err.message}`);
    return parsedText;
  }
}

// Extractor function based on MIME type
async function extractTextFromFile(drive, file, { apiKey = null, model = 'gemini-2.5-flash' } = {}) {
  const mimeType = file.mimeType;
  const fileId = file.id;

  if (mimeType === 'application/vnd.google-apps.document') {
    // Export Google Docs to plain text
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    }, { responseType: 'text' });
    return res.data;
  }

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    // Export Google Sheet to CSV
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/csv',
    }, { responseType: 'text' });
    return res.data;
  }

  // Binary files download
  const res = await drive.files.get({
    fileId,
    alt: 'media',
  }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);

  if (mimeType === 'application/pdf') {
    return extractPdfText(buffer, { apiKey, model });
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'application/msword') {
    const text = buffer.toString('utf8');
    // Extract printable characters plus basic spacing
    return text.replace(/[^\x20-\x7E\xA0-\xFF\s]/g, '');
  }

  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return buffer.toString('utf8');
  }

  throw new Error(`MIME type no soportado: ${mimeType}`);
}

// Helper to list all files recursively
async function listFilesRecursively(drive, folderId, folderPath = '') {
  let files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum, size, webViewLink)',
      pageToken,
    });
    const items = res.data.files || [];
    for (const item of items) {
      const fullPath = folderPath ? `${folderPath}/${item.name}` : item.name;
      // Skip "NO_INDEXAR" or "no-indexar" folders/files
      const pathLower = fullPath.toLowerCase();
      if (pathLower.includes('no_indexar') || pathLower.includes('no-indexar')) {
        continue;
      }
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await listFilesRecursively(drive, item.id, fullPath);
        files.push(...subFiles);
      } else {
        files.push({
          ...item,
          path: fullPath,
        });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

// Extract H1 title from Markdown content
function extractH1Title(mdContent, fallback) {
  const match = mdContent.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

// Main Runner
async function main() {
  const { values } = parseArgs({
    options: {
      'write-candidates': { type: 'boolean', default: false },
      'apply': { type: 'boolean', default: false },
      'force': { type: 'boolean', default: false },
      'kb-root': { type: 'string', default: defaultKbRoot },
      'out': { type: 'string', default: defaultStateDir },
      'model': { type: 'string', default: 'gemini-2.5-flash' },
      'help': { type: 'boolean', default: false },
    }
  });

  if (values.help) {
    console.log(`Sophia Google Drive Scraper
    
Uso:
  node scrape_drive.mjs --write-candidates [--force] [--kb-root=...] [--out=...] [--model=...]
  node scrape_drive.mjs --apply [--kb-root=...] [--out=...]

Env:
  SOPHIA_DRIVE_FOLDER_ID   ID de la carpeta raíz de Google Drive.
  GEMINI_API_KEY           API key de Google Gemini.
  GOOGLE_APPLICATION_CREDENTIALS o SOPHIA_DRIVE_SA_KEY
`);
    process.exit(0);
  }

  const folderId = process.env.SOPHIA_DRIVE_FOLDER_ID || '1Wq7CF-INKKGOMwrbuHPQDMa9ExW7AY8W';
  const apiKey = process.env.GEMINI_API_KEY;
  const kbRoot = values['kb-root'];
  const stateDir = values['out'];
  const candidatesDir = join(stateDir, 'candidates');
  const compRoot = join(kbRoot, 'complementos');

  if (!folderId) {
    console.error('ERROR: Falta env SOPHIA_DRIVE_FOLDER_ID o carpeta por defecto.');
    process.exit(1);
  }

  // Setup directories
  await mkdir(stateDir, { recursive: true });
  await mkdir(candidatesDir, { recursive: true });
  if (values['apply']) {
    await mkdir(compRoot, { recursive: true });
  }

  // Load existing state
  const statePath = join(stateDir, 'drive.meta.json');
  let driveState = { lastSynced: null, files: {} };
  if (existsSync(statePath)) {
    try {
      driveState = JSON.parse(await readFile(statePath, 'utf8'));
    } catch (err) {
      console.warn('Advertencia: No se pudo parsear drive.meta.json, se creará uno nuevo.');
    }
  }

  // Apply phase only moves candidates and updates index
  if (values['apply']) {
    console.log('--- Iniciando fase APPLY ---');
    const candidates = Object.values(driveState.files).filter(f => f.status === 'candidate');
    const deletedFiles = Object.values(driveState.files).filter(f => f.status === 'deleted');

    if (candidates.length === 0 && deletedFiles.length === 0) {
      console.log('Sin cambios pendientes para aplicar.');
      process.exit(0);
    }

    const indexPath = join(kbRoot, 'indice.json');
    if (!existsSync(indexPath)) {
      console.error(`ERROR: No se encontró indice.json en ${kbRoot}`);
      process.exit(1);
    }
    const indexData = JSON.parse(await readFile(indexPath, 'utf8'));
    const itemsMap = new Map(indexData.items.map(item => [item.path, item]));

    // 1. Move candidates to complementos/ and update index
    for (const file of candidates) {
      const slug = file.slug;
      const candPath = join(candidatesDir, `${slug}.md`);
      const targetPath = join(compRoot, `${slug}.md`);
      const relPath = `complementos/${slug}.md`;

      if (existsSync(candPath)) {
        const content = await readFile(candPath, 'utf8');
        await writeFile(targetPath, content, 'utf8');
        console.log(`Copiado candidate a KB: ${relPath}`);

        const title = extractH1Title(content, file.name.replace(/\.[^/.]+$/, ""));
        itemsMap.set(relPath, {
          path: relPath,
          title,
          category: 'Complementario',
          sector: file.sector || undefined,
          canonicalUrl: file.webViewLink || undefined
        });

        // Update file status in state
        file.status = 'synchronized';
        file.lastProcessed = new Date().toISOString();
        // Remove candidate file to clean up
        try {
          await unlink(candPath);
        } catch {}
      } else {
        console.error(`ERROR: No se encontró el archivo candidato: ${candPath}`);
      }
    }

    // 2. Handle deleted files
    for (const file of deletedFiles) {
      const slug = file.slug;
      const targetPath = join(compRoot, `${slug}.md`);
      const relPath = `complementos/${slug}.md`;

      if (existsSync(targetPath)) {
        await unlink(targetPath);
        console.log(`Eliminado del KB: ${relPath}`);
      }
      itemsMap.delete(relPath);
      
      // Remove from state entirely
      delete driveState.files[file.id];
    }

    // 3. Save index
    indexData.version = (indexData.version || 0) + 1;
    indexData.lastUpdated = new Date().toISOString().slice(0, 10);
    indexData.items = Array.from(itemsMap.values());
    await writeFile(indexPath, JSON.stringify(indexData, null, 2) + '\n', 'utf8');
    console.log(`Actualizado indice.json (versión ${indexData.version})`);

    // Regenerate routing metadata to include new files
    try {
      console.log('Regenerando routing_metadata.json por cambios en el índice (Drive sync)...');
      const { execSync } = await import('node:child_process');
      execSync(`node "${join(here, 'generate_routing_metadata.mjs')}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Error al regenerar routing_metadata.json:', err.message);
    }

    // Save state
    driveState.lastSynced = new Date().toISOString();
    await writeFile(statePath, JSON.stringify(driveState, null, 2) + '\n', 'utf8');
    console.log('drive.meta.json actualizado.');
    console.log('Fase APPLY completada con éxito.');
    process.exit(0);
  }

  // Default: Scrape and generate candidates
  console.log('--- Iniciando fase SCRAPE ---');
  if (!apiKey) {
    console.error('ERROR: Falta env GEMINI_API_KEY');
    process.exit(1);
  }

  // Auth setup
  const authOpts = {
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  };
  if (process.env.SOPHIA_DRIVE_SA_KEY) {
    try {
      authOpts.credentials = JSON.parse(process.env.SOPHIA_DRIVE_SA_KEY);
    } catch (err) {
      console.error('Error al parsear SOPHIA_DRIVE_SA_KEY JSON:', err.message);
      process.exit(1);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    authOpts.keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  const auth = new google.auth.GoogleAuth(authOpts);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`Conectando con Google Drive... Folder ID: ${folderId}`);
  let driveFiles = [];
  try {
    driveFiles = await listFilesRecursively(drive, folderId);
    console.log(`Listado completo. Encontrados ${driveFiles.length} archivos válidos (excluyendo NO_INDEXAR).`);
  } catch (err) {
    console.error('Error al listar archivos de Google Drive:', err.message);
    process.exit(1);
  }

  // Read template
  const templatePath = join(here, 'template_complemento.md');
  if (!existsSync(templatePath)) {
    console.error(`ERROR: No se encontró la plantilla de complementos en: ${templatePath}`);
    process.exit(1);
  }
  const templateContent = await readFile(templatePath, 'utf8');

  // Read index to search for duplicates
  const indexPath = join(kbRoot, 'indice.json');
  let indexItems = [];
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(await readFile(indexPath, 'utf8'));
      indexItems = idx.items || [];
    } catch (err) {
      console.warn('Advertencia: No se pudo leer el índice para el chequeo de duplicados:', err.message);
    }
  }

  const listedIds = new Set(driveFiles.map(f => f.id));
  const newFilesState = {};

  // Track summary stats
  let processedCount = 0;
  let skippedUnchanged = 0;
  let skippedDuplicate = 0;
  let errorCount = 0;

  for (const file of driveFiles) {
    const slug = slugify(file.path.replace(/\.[^/.]+$/, ""));
    let sector = resolveSectorFromDrivePath(file.path) || undefined;
    const prevFile = driveState.files[file.id];
    
    // Check if unchanged
    const hasChanged = values['force'] || !prevFile || prevFile.modifiedTime !== file.modifiedTime || prevFile.slug !== slug;

    if (!hasChanged) {
      console.log(`[Skip] ${file.path} sin cambios desde ${file.modifiedTime}`);
      newFilesState[file.id] = prevFile;
      skippedUnchanged++;
      continue;
    }

    console.log(`[Procesando] ${file.path} (${file.mimeType})...`);
    try {
      // 1. Extract text (PDFs: multimodal-first con Gemini para captar tablas como imagen)
      const extractedText = await extractTextFromFile(drive, file, { apiKey, model: values['model'] });
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('El texto extraído está vacío.');
      }

      // La carpeta no matcheó ningún alias: resolvemos el sector con IA.
      if (!sector) {
        sector = await classifySectorWithGemini({
          apiKey,
          drivePath: file.path,
          fileName: file.name,
          textSnippet: extractedText,
          model: values['model'],
        });
        if (sector) {
          console.log(`  [Sector] Resuelto por IA: ${sector} (carpeta sin alias en taxonomía)`);
        }
      }

      // 2. Hash check
      const textHash = getSha256(extractedText);
      if (prevFile && prevFile.hash === textHash && !values['force']) {
        console.log(`  [Skip] ${file.path} tiene el mismo contenido hash.`);
        newFilesState[file.id] = {
          ...prevFile,
          modifiedTime: file.modifiedTime,
          path: file.path,
          slug,
          lastProcessed: new Date().toISOString()
        };
        skippedUnchanged++;
        continue;
      }

      // 3. Deduplication Check
      const pathSegments = file.path.split('/');
      const folderName = pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : '';
      const existingDocs = await findPotentialDuplicates(file.name, folderName, indexItems, kbRoot);
      
      const dupCheck = await checkIsDuplicate(apiKey, file.name, extractedText, existingDocs, values['model']);
      if (dupCheck.isDuplicate) {
        console.log(`  [Skipped] Duplicado detectado por Gemini (similitud: ${dupCheck.similarityRatio}). Explicación: ${dupCheck.explanation}`);
        newFilesState[file.id] = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          path: file.path,
          slug,
          status: 'skipped (duplicate)',
          hash: textHash,
          explanation: dupCheck.explanation,
          lastProcessed: new Date().toISOString()
        };
        skippedDuplicate++;
        
        // Remove any old candidate file if it exists
        const candPath = join(candidatesDir, `${slug}.md`);
        if (existsSync(candPath)) {
          await unlink(candPath);
        }
        continue;
      }

      // 4. Formatting and Candidate Generation
      let mdContent = '';
      const isCsv = file.mimeType === 'application/vnd.google-apps.spreadsheet' || file.mimeType === 'text/csv';

      if (isCsv) {
        const mdTable = csvToMarkdownTable(extractedText);
        mdContent = formatCsvAsMarkdownComplement(file.name, file.id, file.modifiedTime, file.webViewLink, mdTable);
      } else {
        const geminiContent = await formatComplementWithGemini(apiKey, file, extractedText, templateContent, values['model']);
        
        let cleanedGeminiContent = sanitizeKbMarkdown(geminiContent.trim());
        // Remove any trailing lines like "---" or "## Metadatos del Documento" / "## Fuentes consultadas" if Gemini generated them anyway
        const metadataIdx = cleanedGeminiContent.search(/^##\s+Metadatos del Documento/mi);
        if (metadataIdx !== -1) {
          cleanedGeminiContent = cleanedGeminiContent.slice(0, metadataIdx).trim();
        }
        
        // Remove trailing divider if exists at the end of the cleaned text
        if (cleanedGeminiContent.endsWith('---')) {
          cleanedGeminiContent = cleanedGeminiContent.slice(0, -3).trim();
        }

        mdContent = `${cleanedGeminiContent}

---

## Metadatos del Documento

- **Origen**: Google Drive (\`${file.name}\`)
- **ID de Archivo**: \`${file.id}\`
- **Fecha de Modificación en Drive**: \`${file.modifiedTime}\`
- **Categoría**: Complemento Institucional

## Fuentes consultadas

- [${file.name}](${file.webViewLink})
`;
      }

      if (!mdContent.endsWith('\n')) {
        mdContent += '\n';
      }

      // 5. Save candidate file
      if (values['write-candidates']) {
        const candPath = join(candidatesDir, `${slug}.md`);
        await mkdir(dirname(candPath), { recursive: true });
        await writeFile(candPath, mdContent, 'utf8');
        console.log(`  [Candidate] Guardado candidate en: state/complementos/candidates/${slug}.md`);
        
        newFilesState[file.id] = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          path: file.path,
          slug,
          sector,
          status: 'candidate',
          hash: textHash,
          webViewLink: file.webViewLink,
          lastProcessed: new Date().toISOString()
        };
      } else {
        console.log(`  [Dry-run] Procesado con éxito (no --write-candidates)`);
        newFilesState[file.id] = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          path: file.path,
          slug,
          sector,
          status: 'pending-write',
          hash: textHash,
          webViewLink: file.webViewLink,
          lastProcessed: new Date().toISOString()
        };
      }

      processedCount++;

    } catch (err) {
      console.error(`  [Error] No se pudo procesar ${file.path}:`, err.message);
      errorCount++;
      newFilesState[file.id] = prevFile || {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        path: file.path,
        slug,
        status: 'error',
        error: err.message,
        lastProcessed: new Date().toISOString()
      };
    }
  }

  // 6. Reconciliation of deletions
  for (const prevId of Object.keys(driveState.files)) {
    if (!listedIds.has(prevId)) {
      const prevFile = driveState.files[prevId];
      if (prevFile.status !== 'deleted') {
        console.log(`[Detectada Eliminación] El archivo ${prevFile.path} ya no existe en Drive. Marcando como eliminado.`);
        newFilesState[prevId] = {
          ...prevFile,
          status: 'deleted',
          lastProcessed: new Date().toISOString()
        };

        const candPath = join(candidatesDir, `${prevFile.slug}.md`);
        if (existsSync(candPath)) {
          try {
            await unlink(candPath);
          } catch {}
        }
      } else {
        newFilesState[prevId] = prevFile;
      }
    }
  }

  // 7. Write updated state
  driveState.files = newFilesState;
  await writeFile(statePath, JSON.stringify(driveState, null, 2) + '\n', 'utf8');
  console.log(`drive.meta.json actualizado en ${statePath}`);

  // Summary Report
  console.log('\n--- Resumen de Ingesta ---');
  console.log(`Nuevos / Modificados procesados: ${processedCount}`);
  console.log(`Saltados sin cambios: ${skippedUnchanged}`);
  console.log(`Saltados por duplicación: ${skippedDuplicate}`);
  console.log(`Errores: ${errorCount}`);
  console.log(`Sincronización terminada.`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
