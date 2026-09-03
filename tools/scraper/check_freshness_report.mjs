import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateFreshnessReport, parseReferenceDate } from './freshness_report.mjs';

const REPORT_DATE_RE = /^\*\*Generado el:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/m;

export async function checkFreshnessReport({ kbRoot, stateDir }) {
  const reportPath = resolve(kbRoot, 'freshness.md');
  if (!existsSync(reportPath)) throw new Error(`freshness.md no encontrado en ${kbRoot}`);

  const trackedReport = await readFile(reportPath, 'utf8');
  const dateMatch = trackedReport.match(REPORT_DATE_RE);
  if (!dateMatch) {
    throw new Error('freshness.md no contiene una fecha de generación YYYY-MM-DD válida.');
  }

  const expectedReport = await generateFreshnessReport({
    kbRoot,
    stateDir,
    format: 'md',
    today: parseReferenceDate(dateMatch[1]),
  });

  if (trackedReport !== expectedReport) {
    throw new Error(
      'freshness.md está desactualizado respecto de los datos canónicos. ' +
      `Regenerarlo con: node tools/scraper/freshness_report.mjs --kb-root=../.. --format=md --reference-date=${dateMatch[1]} --out=freshness.md`,
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '.' },
      'state': { type: 'string', default: 'tools/scraper/state' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log('Uso: node check_freshness_report.mjs [--kb-root=. ] [--state=tools/scraper/state]');
    return;
  }

  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(process.cwd(), values['kb-root']);
  const stateDir = values.state.startsWith('/') ? values.state : resolve(process.cwd(), values.state);

  await checkFreshnessReport({ kbRoot, stateDir });
  console.log('freshness.md coincide con los datos canónicos para su fecha de referencia.');
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
