// Registro de calidad de la ingesta de Drive y resumen mensual.
//
// Cada corrida agrega una línea al registro (rama drive-quality-log) con sus
// problemas por archivo y tipo. Una vez por mes se publica un issue con los
// tipos de problema más frecuentes, las carpetas donde ocurren y los archivos
// que siguen fallando: insumo para mejorar la guía de carga y el proceso.
//
// El repo es público: el registro no guarda personas ni mails.
//
//   node drive_quality.mjs append <reporte.json> <registro.jsonl>
//   node drive_quality.mjs report <registro.jsonl> <AAAA-MM>     → markdown

import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';

const KIND_LABEL = {
  formato: 'Formato no soportado',
  'sin-texto': 'Sin texto legible',
  'demasiado-largo': 'Demasiado largo',
  'transcripcion-incompleta': 'Transcripción incompleta',
  transitorio: 'Falla temporal',
  otro: 'Otro',
  'carpeta-raiz': 'Archivo en la carpeta principal',
  'nombre-generico': 'Nombre genérico',
  'posible-duplicado': 'Posible duplicado',
  'datos-personales': 'Posibles datos personales',
};

const pick = (item) => ({ path: item.path, kind: item.kind });

export function logEntry(report, now = new Date()) {
  return {
    at: report.generatedAt || now.toISOString(),
    errors: (report.errors || []).map(pick),
    warnings: (report.warnings || []).map(pick),
    processed: (report.processed || []).length,
  };
}

const folderOf = (path) => (String(path).includes('/') ? String(path).split('/')[0] : '(carpeta principal)');

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// Resumen de un mes (AAAA-MM) a partir de las líneas del registro.
export function monthlyReport(entries, month) {
  const runs = entries.filter((entry) => String(entry.at).startsWith(month));
  if (!runs.length) return `# Calidad de la carga en Drive — ${month}\n\nNo hubo corridas de la ingesta en el mes.\n`;
  const errors = runs.flatMap((run) => run.errors);
  const warnings = runs.flatMap((run) => run.warnings);
  const processed = runs.reduce((total, run) => total + run.processed, 0);
  const failingRuns = new Map();
  for (const run of runs) for (const path of new Set(run.errors.map((error) => error.path))) failingRuns.set(path, (failingRuns.get(path) || 0) + 1);
  const recurrent = [...failingRuns].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  const last = runs.at(-1);
  const table = (rows, header) => (rows.length ? [`| ${header} | Casos |`, '| --- | --- |', ...rows.map(([label, count]) => `| ${label} | ${count} |`)].join('\n') : 'Ninguno.');

  return [
    `# Calidad de la carga en Drive — ${month}`,
    '',
    `- Corridas de la ingesta: **${runs.length}**`,
    `- Documentos procesados bien: **${processed}**`,
    `- Problemas que impidieron procesar un documento: **${errors.length}** (en ${failingRuns.size} archivos)`,
    `- Avisos de carga (carpeta, nombre, duplicados, datos personales): **${warnings.length}**`,
    '',
    '## Problemas por tipo',
    '',
    table(countBy([...errors, ...warnings], (item) => KIND_LABEL[item.kind] || item.kind), 'Tipo'),
    '',
    '## Problemas por carpeta',
    '',
    table(countBy([...errors, ...warnings], (item) => folderOf(item.path)), 'Carpeta'),
    '',
    '## Archivos que fallaron en 3 corridas o más',
    '',
    recurrent.length ? recurrent.map(([path, count]) => `- ${path} (${count} corridas)`).join('\n') : 'Ninguno.',
    '',
    '## Pendientes al cierre del mes',
    '',
    last.errors.length ? last.errors.map((error) => `- ${error.path}: ${KIND_LABEL[error.kind] || error.kind}`).join('\n') : 'Ninguno.',
    '',
    '## Para la mejora continua',
    '',
    '- Si un tipo de problema se repite, sumar un ejemplo concreto a la guía de carga (docs/GUIA_CARGA_DRIVE.md y su copia en Drive).',
    '- Si un archivo falla varias corridas seguidas, revisarlo con quien lo subió: el aviso por mail ya le indicó qué hacer.',
    '- Si aparece un error nuevo del proceso, convertirlo en una prueba y, si corresponde, en una guarda.',
    '',
  ].join('\n');
}

async function main([command, ...args]) {
  if (command === 'append') {
    const [reportPath, logPath] = args;
    if (!existsSync(reportPath)) return;
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    await appendFile(logPath, `${JSON.stringify(logEntry(report))}\n`, 'utf8');
  } else if (command === 'report') {
    const [logPath, month] = args;
    const entries = existsSync(logPath)
      ? (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    process.stdout.write(monthlyReport(entries, month));
  } else {
    console.error('Uso: node drive_quality.mjs <append|report> ...');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
