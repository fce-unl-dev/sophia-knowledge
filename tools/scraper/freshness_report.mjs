import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HUMAN_REVIEW_METADATA_RE = /^\s*\*\*Última revisión humana\*\*:\s*(.+?)\s*$/im;
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;
const DRAFT_DATE_RE = /\bdraft\s+autogenerado\s+el\s+(\d{4}-\d{2}-\d{2})\b/i;

function parseIsoDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Classifies the review metadata written by both the content generator and the
 * post-merge workflow. Keeping this parser in one place prevents a format
 * change in either producer from silently turning reviewed documents into N/D.
 */
export function parseHumanReviewMetadata(mdContent) {
  const metadataMatch = mdContent.match(HUMAN_REVIEW_METADATA_RE);
  if (!metadataMatch) {
    return { reviewStatus: 'Pendiente / N/D', isDraft: false, humanDate: null };
  }

  const metadata = metadataMatch[1].trim();
  const draftDateMatch = metadata.match(DRAFT_DATE_RE);
  if (/^PENDIENTE\b/i.test(metadata)) {
    return {
      reviewStatus: draftDateMatch ? 'Draft autogenerado' : 'Pendiente / N/D',
      isDraft: Boolean(draftDateMatch),
      humanDate: draftDateMatch ? parseIsoDate(draftDateMatch[1]) : null,
    };
  }

  const reviewDateMatch = metadata.match(ISO_DATE_RE);
  const humanDate = reviewDateMatch ? parseIsoDate(reviewDateMatch[1]) : null;
  return {
    reviewStatus: humanDate ? 'Revisado' : 'Pendiente / N/D',
    isDraft: false,
    humanDate,
  };
}

export function parseReferenceDate(value) {
  const date = parseIsoDate(value);
  if (!date) {
    throw new Error(`Fecha de referencia inválida: ${value}. Usar YYYY-MM-DD.`);
  }
  return date;
}

function diffDays(dateA, dateB) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((dateA.getTime() - dateB.getTime()) / msPerDay);
}

export async function generateFreshnessReport({ kbRoot, stateDir, format, today = new Date() }) {
  const indexPath = join(kbRoot, 'indice.json');
  const sourcesPath = join(kbRoot, 'tools/scraper/sources.json');

  if (!existsSync(indexPath)) throw new Error(`indice.json no encontrado en ${kbRoot}`);
  if (!existsSync(sourcesPath)) throw new Error(`sources.json no encontrado en ${sourcesPath}`);

  const indice = JSON.parse(await readFile(indexPath, 'utf8'));
  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));

  const items = (indice.items || []).filter(i => i.path && i.path.endsWith('.md'));
  const results = [];

  for (const item of items) {
    const mdPath = join(kbRoot, item.path);
    let mdContent = '';
    if (existsSync(mdPath)) {
      mdContent = await readFile(mdPath, 'utf8');
    }

    // Calcular Staleness Humano
    const { humanDate, isDraft, reviewStatus } = parseHumanReviewMetadata(mdContent);

    let humanStalenessDays = humanDate && !Number.isNaN(humanDate.getTime()) 
      ? diffDays(today, humanDate) 
      : Infinity;

    // Buscar el source y el meta.json
    let metaPath = null;
    let source = sourcesData.sources.find(s => s.indice_path === item.path);
    
    if (!source && item.path.startsWith('cursos/')) {
      source = sourcesData.sources.find(s => s.slug === 'cursos-de-formacion');
    }
    
    if (source) {
      if (source.slug === 'cursos-de-formacion') {
        metaPath = join(stateDir, 'cursos-de-formacion/cursos-de-formacion.meta.json');
      } else if (source.slug.startsWith('estudiantes-')) {
        metaPath = join(stateDir, 'estudiantes/estudiantes.meta.json');
      } else {
        metaPath = join(stateDir, `${source.slug}.meta.json`);
      }
    }

    let autoDate = null;
    if (metaPath && existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        const dateStr = meta.last_checked_at || meta.scraped_at;
        if (dateStr) autoDate = new Date(dateStr);
      } catch {
        // Ignorar meta corrupto
      }
    }

    let autoStalenessDays = autoDate && !Number.isNaN(autoDate.getTime())
      ? diffDays(today, autoDate)
      : Infinity;

    results.push({
      path: item.path,
      title: item.title || item.path,
      category: item.category,
      reviewStatus,
      isDraft,
      humanStalenessDays,
      autoStalenessDays,
      humanDateStr: humanDate && !Number.isNaN(humanDate.getTime()) ? humanDate.toISOString().slice(0, 10) : 'N/D',
      autoDateStr: autoDate && !Number.isNaN(autoDate.getTime()) ? autoDate.toISOString().slice(0, 10) : 'N/D',
    });
  }

  // Ordenar: Primero los drafts más viejos, luego los no revisados, luego los revisados más viejos
  results.sort((a, b) => {
    // Prioridad 1: Drafts y Sin revisión primero
    const aPriority = a.isDraft || a.reviewStatus.includes('Sin') || a.reviewStatus.includes('Pendiente') ? 0 : 1;
    const bPriority = b.isDraft || b.reviewStatus.includes('Sin') || b.reviewStatus.includes('Pendiente') ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    
    // Prioridad 2: Mayor staleness humano
    if (a.humanStalenessDays !== b.humanStalenessDays) {
      return b.humanStalenessDays - a.humanStalenessDays;
    }
    
    // Prioridad 3: Mayor staleness automático
    if (a.autoStalenessDays !== b.autoStalenessDays) {
      return b.autoStalenessDays - a.autoStalenessDays;
    }
    
    return a.path.localeCompare(b.path);
  });

  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  if (format === 'md') {
    return generateMarkdown(results, today);
  }

  return generateConsoleTable(results);
}

function generateMarkdown(results, today) {
  const lines = [
    '# Reporte de Freshness de la Base de Conocimientos',
    '',
    `**Generado el:** ${today.toISOString().slice(0, 10)}`,
    '',
    '| Archivo | Estado | Días s/ Revisión Humana | Días s/ Scraping Automático |',
    '|---|---|---|---|'
  ];

  for (const r of results) {
    const humanIcon = r.humanStalenessDays > 180 ? '🔴' : (r.isDraft ? '🟡' : '🟢');
    const autoIcon = r.autoStalenessDays > 14 ? '🔴' : '🟢';
    
    const humanStr = r.humanStalenessDays === Infinity ? 'N/D' : `${r.humanStalenessDays} d (${r.humanDateStr})`;
    const autoStr = r.autoStalenessDays === Infinity ? 'N/D' : `${r.autoStalenessDays} d (${r.autoDateStr})`;
    
    lines.push(`| \`${r.path}\` | ${r.reviewStatus} | ${humanIcon} ${humanStr} | ${autoIcon} ${autoStr} |`);
  }

  return lines.join('\n');
}

function generateConsoleTable(results) {
  const maxPath = Math.max(...results.map(r => r.path.length), 10);
  
  const lines = [];
  lines.push(`\nFreshness Report (${results.length} archivos)`);
  lines.push('='.repeat(maxPath + 70));
  lines.push(
    'Path'.padEnd(maxPath + 2) + 
    'Estado'.padEnd(20) + 
    'Rev. Humana'.padEnd(20) + 
    'Scraping Auto'.padEnd(20)
  );
  lines.push('-'.repeat(maxPath + 70));

  for (const r of results) {
    const humanStr = r.humanStalenessDays === Infinity ? 'N/D' : `${r.humanStalenessDays}d (${r.humanDateStr})`;
    const autoStr = r.autoStalenessDays === Infinity ? 'N/D' : `${r.autoStalenessDays}d (${r.autoDateStr})`;
    
    lines.push(
      r.path.padEnd(maxPath + 2) + 
      r.reviewStatus.padEnd(20) + 
      humanStr.padEnd(20) + 
      autoStr.padEnd(20)
    );
  }
  lines.push('='.repeat(maxPath + 70) + '\n');
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '../..' },
      'state': { type: 'string', default: 'state' },
      'format': { type: 'string', default: 'table' },
      'out': { type: 'string' },
      'reference-date': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia KB Freshness Report

Uso:
  node freshness_report.mjs [--kb-root=../..] [--format=table|md|json] [--reference-date=YYYY-MM-DD] [--out=report.md]

Opciones:
  --kb-root=<dir>     Raíz del repositorio KB (default: ../..)
  --state=<dir>       Directorio de estado del scraper (default: state)
  --format=<format>   Formato de salida: table, md, json (default: table)
  --reference-date    Fecha para calcular antigüedad y encabezado (YYYY-MM-DD)
  --out=<file>        Guardar salida en un archivo
`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const stateDir = values.state.startsWith('/') ? values.state : resolve(here, values.state);

  try {
    const report = await generateFreshnessReport({
      kbRoot,
      stateDir,
      format: values.format,
      today: values['reference-date'] ? parseReferenceDate(values['reference-date']) : new Date(),
    });

    if (values.out) {
      await writeFile(resolve(process.cwd(), values.out), report, 'utf8');
      console.log(`Reporte guardado en ${values.out}`);
    } else {
      console.log(report);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
