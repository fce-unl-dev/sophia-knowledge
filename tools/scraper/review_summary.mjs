// Ayuda para la revisión humana de la PR de Drive: por cada documento nuevo o
// cambiado, cuántas tablas y filas tiene, si la numeración de filas es
// continua y el enlace al original para comparar. Caso que lo motivó: LA 484
// (#354) pasó la revisión con la tabla duplicada, las materias 12–27 ausentes
// y una tabla inventada, porque nada invitaba a compararla con el PDF.
//
//   node review_summary.mjs <complementos/a.md> [...]   → sección markdown

import { readFileSync } from 'node:fs';

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function tableStats(markdown) {
  const lines = String(markdown).split('\n');
  let tables = 0;
  let rows = 0;
  const numbers = [];
  lines.forEach((line, index) => {
    if (!TABLE_LINE.test(line) || SEPARATOR_LINE.test(line)) return;
    if (SEPARATOR_LINE.test(lines[index + 1] ?? '')) { tables++; return; }
    rows++;
    const first = line.trim().replace(/^\|/, '').split('|')[0];
    const number = /^\s*\**\s*(\d{1,3})\b/.exec(first)?.[1];
    if (number) numbers.push(Number(number));
  });
  return { tables, rows, numbering: describeNumbering(numbers) };
}

function describeNumbering(numbers) {
  if (numbers.length < 5) return '—';
  const max = Math.max(...numbers);
  const present = new Set(numbers);
  const missing = [];
  for (let number = 1; number <= max; number++) if (!present.has(number)) missing.push(number);
  const repeated = numbers.length - present.size;
  const parts = [missing.length ? `⚠️ faltan ${missing.length} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})` : `1–${max} completa`];
  if (repeated) parts.push(`${repeated} repetidas`);
  return parts.join(', ');
}

const sourceLink = (markdown) => /^## Fuentes consultadas\s*\n+- \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/m.exec(markdown);
const title = (markdown, path) => /^# (.+)$/m.exec(markdown)?.[1]?.trim() || path;

export function renderReviewSummary(documents) {
  if (!documents.length) return '';
  const rows = documents.map(({ path, markdown }) => {
    const { tables, rows: count, numbering } = tableStats(markdown);
    const link = sourceLink(markdown);
    const original = link ? `[original](${link[2]})` : '—';
    const provisional = markdown.includes('**Documento provisorio.**') ? ' · provisorio' : '';
    return `| ${title(markdown, path).replace(/\|/g, '\\|')}${provisional} | ${tables} | ${count} | ${numbering} | ${original} |`;
  });
  return [
    '## Para revisar contra el original',
    '',
    'La transcripción la hace un modelo y puede inventar o perder filas aunque la tabla se vea bien formada. Antes de aprobar, abrí el original y compará al menos las tablas: cantidad de filas, numeración y algunas filas al azar.',
    '',
    '| Documento | Tablas | Filas | Numeración | Original |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const documents = process.argv.slice(2).map((path) => ({ path, markdown: readFileSync(path, 'utf8') }));
  process.stdout.write(renderReviewSummary(documents));
}
