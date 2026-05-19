// Validador de URLs del KB.
//
// Por defecto valida formato sin red (estable para PRs). Con --network hace
// HEAD/GET con timeout y reporta URLs rotas como error.
//
// Uso:
//   node tools/scraper/validate_links.mjs
//   node tools/scraper/validate_links.mjs --network

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_DIRS = [
  'posgrados',
  'diplomaturas',
  'compartidos',
  'operativos',
  'cursos',
  'posgrado-general',
  'estudiantes',
];

const URL_RE = /https?:\/\/[^\s)<>"'`]+[^\s)<>"'`.,;:]/g;
const NETWORK_TIMEOUT_MS = 10_000;
const NETWORK_CONCURRENCY = 6;

export async function validateLinks({ kbRoot, network = false, fetchImpl = fetch } = {}) {
  const errors = [];
  const warnings = [];
  const urlEntries = [];

  await collectIndexUrls({ kbRoot, urlEntries, errors });
  await collectMarkdownUrls({ kbRoot, urlEntries, warnings });
  await collectSourcesUrls({ kbRoot, urlEntries, warnings });

  const seen = new Set();
  const uniqueEntries = [];
  for (const entry of urlEntries) {
    const key = `${entry.url}@@${entry.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }

  for (const entry of uniqueEntries) {
    if (!isValidHttpUrl(entry.url)) {
      errors.push(`${entry.source}: URL inválida: ${entry.url}`);
    }
    if (/\]\(https?:\/\//.test(entry.url)) {
      warnings.push(`${entry.source}: posible parsing incorrecto de Markdown link: ${entry.url}`);
    }
  }

  let networkChecked = 0;
  if (network) {
    const failures = await checkUrls(uniqueEntries, { fetchImpl });
    networkChecked = uniqueEntries.length;
    for (const failure of failures) {
      errors.push(`${failure.source}: URL no respondió OK: ${failure.url} (${failure.status || failure.error})`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      urls_found: uniqueEntries.length,
      network_checked: networkChecked,
      files_scanned: new Set(uniqueEntries.map((entry) => entry.source)).size,
    },
  };
}

async function collectIndexUrls({ kbRoot, urlEntries, errors }) {
  const path = join(kbRoot, 'indice.json');
  if (!existsSync(path)) return;
  try {
    const index = JSON.parse(await readFile(path, 'utf8'));
    for (const [i, item] of (index.items || []).entries()) {
      if (item.canonicalUrl) urlEntries.push({ url: item.canonicalUrl, source: `indice.json items[${i}].canonicalUrl` });
    }
  } catch (err) {
    errors.push(`No se pudo parsear indice.json para validar URLs: ${err.message}`);
  }
}

async function collectSourcesUrls({ kbRoot, urlEntries, warnings }) {
  const path = join(kbRoot, 'tools/scraper/sources.json');
  if (!existsSync(path)) return;
  try {
    const sources = JSON.parse(await readFile(path, 'utf8'));
    for (const [i, source] of (sources.sources || []).entries()) {
      if (source.url) urlEntries.push({ url: source.url, source: `tools/scraper/sources.json sources[${i}].url` });
    }
  } catch (err) {
    warnings.push(`No se pudo parsear sources.json para validar URLs: ${err.message}`);
  }
}

async function collectMarkdownUrls({ kbRoot, urlEntries, warnings }) {
  for (const dir of DEFAULT_DIRS) {
    const absDir = join(kbRoot, dir);
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) continue;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relative = `${dir}/${entry.name}`;
      try {
        const md = await readFile(join(absDir, entry.name), 'utf8');
        for (const url of extractUrls(md)) {
          urlEntries.push({ url, source: relative });
        }
      } catch (err) {
        warnings.push(`${relative}: no se pudo leer para extraer URLs: ${err.message}`);
      }
    }
  }
}

export function extractUrls(text) {
  const urls = [];
  let match;
  while ((match = URL_RE.exec(text)) !== null) {
    urls.push(match[0].replace(/&amp;/g, '&'));
  }
  return urls;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function checkUrls(entries, { fetchImpl }) {
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
      try {
        let res = await fetchImpl(entry.url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        if (res.status === 405 || res.status === 403) {
          res = await fetchImpl(entry.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        }
        if (!res.ok) failures.push({ ...entry, status: res.status });
      } catch (err) {
        failures.push({ ...entry, error: err.name || err.message || String(err) });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(NETWORK_CONCURRENCY, entries.length) }, worker));
  return failures;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string', default: '../..' },
      network: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Sophia KB URL validator\n\nUso:\n  node validate_links.mjs [--network] [--kb-root=../..] [--json]\n`);
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = values['kb-root'].startsWith('/') ? values['kb-root'] : resolve(here, values['kb-root']);
  const result = await validateLinks({ kbRoot, network: values.network });

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exit(result.ok ? 0 : 1);
}

function printHuman(result) {
  console.log(`KB link validation: ${result.ok ? 'OK' : 'FAILED'}`);
  console.log(JSON.stringify(result.summary, null, 2));
  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
  if (result.errors.length) {
    console.error('\nErrors:');
    for (const error of result.errors) console.error(`- ${error}`);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
