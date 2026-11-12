import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENDA_URL, parseAgendaHtml } from './scrape_agenda.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_HTML_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const localDate = new Intl.DateTimeFormat('en', {
  timeZone: 'America/Argentina/Cordoba', year: 'numeric', month: '2-digit', day: '2-digit',
});

function cordobaDay(now) {
  const parts = Object.fromEntries(localDate.formatToParts(now).map(({ type, value }) => [type, value]));
  return [parts.year, parts.month, parts.day].join('-');
}

async function fetchAgendaHtml(fetchImpl) {
  const response = await fetchImpl(AGENDA_URL, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/html' },
  });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== AGENDA_URL) ||
      !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('The official agenda did not return an HTML listing.');
  }
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_HTML_BYTES)) {
    await response.body?.cancel();
    throw new Error('The official agenda exceeded the HTML size limit.');
  }
  if (!response.body) throw new Error('The official agenda response had no body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let html = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error('The official agenda exceeded the HTML size limit.');
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function replaceSnapshot(repositoryRoot, snapshot) {
  const directory = path.join(repositoryRoot, 'agenda');
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error('The agenda output directory must not be a symbolic link.');
  }
  const temporaryDirectory = await mkdtemp(path.join(directory, '.snapshot-'));
  try {
    const temporaryFile = path.join(temporaryDirectory, 'institucional.json');
    await writeFile(temporaryFile, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    await rename(temporaryFile, path.join(directory, 'institucional.json'));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Refresh the fixed repository snapshot; clock, transport and root can be isolated in tests. */
export async function buildAgendaSnapshot({
  fetchImpl = globalThis.fetch, now = () => new Date(), repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  let html;
  try {
    html = await fetchAgendaHtml(fetchImpl);
  } catch (error) {
    throw new Error('Could not fetch the official agenda; the snapshot was not changed.', { cause: error });
  }
  const refreshed = now();
  const result = parseAgendaHtml(html, { today: cordobaDay(refreshed) });
  if (result.status === 'invalid') {
    throw new Error(`Could not validate the official agenda (${result.reason}); the snapshot was not changed.`);
  }
  const snapshot = {
    schemaVersion: 1,
    refreshedAt: refreshed.toISOString(),
    events: result.events,
  };
  await replaceSnapshot(repositoryRoot, snapshot);
  return snapshot;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error('Usage: node tools/scraper/build_agenda_snapshot.mjs');
    process.exitCode = 1;
  } else {
    try {
      const { events } = await buildAgendaSnapshot();
      console.log(`Updated agenda/institucional.json with ${events.length} events.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
