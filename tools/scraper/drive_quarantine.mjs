// Cuarentena visible de la ingesta de Drive.
//
// Un archivo que no se puede procesar no entra al KB: queda en error y se
// reintenta en la próxima corrida. Hasta el 30/10/2026 eso solo quedaba en el
// log, y documentos vacíos o descartados pasaban días sin que nadie lo viera.
// Este módulo traduce cada error a una indicación para quien subió el archivo
// y arma el reporte que el workflow publica en el resumen, la PR y un issue.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileSummary } from './drive_upload_checks.mjs';

const FORMAT_ADVICE = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Guardalo como Hoja de cálculo de Google en la misma carpeta.',
  'application/vnd.ms-excel': 'Guardalo como Hoja de cálculo de Google en la misma carpeta.',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Guardalo como Presentación de Google o exportalo a PDF.',
  'application/vnd.ms-powerpoint': 'Guardalo como Presentación de Google o exportalo a PDF.',
};

// Cada regla: patrón sobre el mensaje de error → tipo e indicación.
const RULES = [
  {
    kind: 'formato',
    test: (message) => /MIME type no soportado/i.test(message),
    advice: (file) => FORMAT_ADVICE[file.mimeType] || 'Guardalo como Documento de Google, Hoja de cálculo de Google o PDF con texto seleccionable.',
  },
  {
    kind: 'sin-texto',
    test: (message) => /caracteres útiles, por debajo del mínimo/i.test(message) && /scrape de/i.test(message),
    advice: () => 'No se pudo leer texto: suele ser un PDF escaneado o una imagen. Subí una versión con texto seleccionable o el documento original.',
  },
  {
    kind: 'demasiado-largo',
    test: (message) => /límite de tokens de salida/i.test(message),
    advice: () => 'El documento es demasiado largo para transcribirse de una vez. Se reintenta solo; si persiste, conviene dividirlo en partes.',
  },
  {
    kind: 'transcripcion-incompleta',
    test: (message) => /declara contenido faltante|caracteres útiles.*aunque el texto extraído|no conservó las tablas|identificadores del original|inventó contenido|Se perdió parte de la tabla|repite la estructura/i.test(message),
    advice: () => 'No se pudo transcribir parte del contenido (frecuente con tablas como imagen). Se reintenta solo; si persiste, subí la tabla como Hoja de cálculo de Google.',
  },
  {
    kind: 'transitorio',
    test: (message) => /aborted|timeout|ETIMEDOUT|ECONNRESET|fetch failed|HTTP (?:429|5\d\d)|sin texto/i.test(message),
    advice: () => 'Falla temporal del servicio. Se reintenta sola en la próxima corrida; no hace falta hacer nada.',
  },
];

export function diagnoseDriveError(file, message) {
  const text = String(message || '');
  const rule = RULES.find((candidate) => candidate.test(text));
  return {
    ...fileSummary(file),
    mimeType: file.mimeType,
    kind: rule?.kind || 'otro',
    advice: rule ? rule.advice(file) : 'Revisar el log de la corrida de Ingest Drive.',
    reason: text,
  };
}

const KIND_LABEL = {
  formato: 'Formato no soportado',
  'sin-texto': 'Sin texto legible',
  'demasiado-largo': 'Demasiado largo',
  'transcripcion-incompleta': 'Transcripción incompleta',
  transitorio: 'Falla temporal',
  otro: 'Otro',
};

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

// Sección markdown con un archivo por fila. Vacío si no hubo errores.
export function renderQuarantineMarkdown(errors, { heading = '## No procesados' } = {}) {
  if (!errors?.length) return '';
  const rows = errors.map((error) => {
    const name = error.webViewLink ? `[${cell(error.path)}](${error.webViewLink})` : cell(error.path);
    return `| ${name} | ${KIND_LABEL[error.kind] || KIND_LABEL.otro} | ${cell(error.advice)} |`;
  });
  return [
    heading,
    '',
    `${errors.length} archivo(s) de Drive quedaron fuera del KB en esta corrida. No entran incompletos: se reintentan solos en la próxima.`,
    '',
    '| Archivo | Problema | Qué hacer |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

// processed: archivos que esta corrida procesó bien; warnings: avisos de higiene.
export async function writeRunReport(path, errors, now = new Date(), { processed = [], warnings = [] } = {}) {
  const report = { generatedAt: now.toISOString(), errors, processed, warnings };
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

// Anotaciones de GitHub Actions: una advertencia por archivo en el resumen del run.
export function renderWarnings(errors) {
  return (errors || []).map((error) => `::warning title=Drive no procesado::${cell(error.path)}: ${cell(error.advice)}`).join('\n');
}

// CLI del workflow:
//   node drive_quarantine.mjs markdown <reporte.json>   sección markdown (vacía sin errores)
//   node drive_quarantine.mjs warnings <reporte.json>   anotaciones ::warning
//   node drive_quarantine.mjs count <reporte.json>      cantidad de archivos no procesados
// Un reporte ausente (la fase de scrape no llegó a escribirlo) cuenta como sin errores.
async function main([command, reportPath]) {
  const errors = reportPath && existsSync(reportPath)
    ? JSON.parse(await readFile(reportPath, 'utf8')).errors || []
    : [];
  if (command === 'markdown') process.stdout.write(renderQuarantineMarkdown(errors));
  else if (command === 'warnings') process.stdout.write(renderWarnings(errors) + (errors.length ? '\n' : ''));
  else if (command === 'count') process.stdout.write(`${errors.length}\n`);
  else {
    console.error('Uso: node drive_quarantine.mjs <markdown|warnings|count> <reporte.json>');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
