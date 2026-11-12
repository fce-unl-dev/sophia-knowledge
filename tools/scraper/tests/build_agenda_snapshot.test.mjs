import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildAgendaSnapshot } from '../build_agenda_snapshot.mjs';
import { AGENDA_URL } from '../scrape_agenda.mjs';

const page = (body = '') => '<div class="paginaComun"><div class="formulario">' + body + '</div></div>';
const event = (date, title) => '<div class="evento">' + date + ' | <a href="index.php?idEvento=989">' + title + '</a></div>';
const htmlResponse = (body, options = {}) => new Response(body, {
  ...options,
  headers: { 'content-type': 'text/html; charset=UTF-8', ...options.headers },
});

async function fixture(t) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'agenda-snapshot-test-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  return {
    repositoryRoot,
    destination: path.join(repositoryRoot, 'agenda', 'institucional.json'),
    now: () => new Date('2026-11-12T02:59:59.000Z'),
  };
}

test('uses the fixed official GET, the Córdoba day and the v1 snapshot path and shape', async t => {
  const { destination, ...options } = await fixture(t);
  const html = page(event('10-11-2026', 'Anterior') + event('11-11-2026', 'Hoy en Córdoba'));
  const snapshot = await buildAgendaSnapshot({
    ...options,
    fetchImpl: async (url, init) => {
      assert.equal(url, AGENDA_URL);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return htmlResponse(html);
    },
  });
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    refreshedAt: '2026-11-12T02:59:59.000Z',
    events: [{ date: '2026-11-11', title: 'Hoy en Córdoba', url: AGENDA_URL + 'index.php?idEvento=989' }],
  });
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), snapshot);
  assert.deepEqual(await readdir(path.dirname(destination)), ['institucional.json']);
});

test('replaces rather than appends, including a valid empty listing', async t => {
  const { destination, ...options } = await fixture(t);
  await buildAgendaSnapshot({ ...options, fetchImpl: async () => htmlResponse(page(event('11-11-2026', 'Removido'))) });
  const snapshot = await buildAgendaSnapshot({
    ...options,
    now: () => new Date('2026-11-12T03:00:00.000Z'),
    fetchImpl: async () => htmlResponse(page(event('11-11-2026', 'Expirado'))),
  });
  assert.deepEqual(snapshot, { schemaVersion: 1, refreshedAt: '2026-11-12T03:00:00.000Z', events: [] });
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), snapshot);
  assert.deepEqual(await readdir(path.dirname(destination)), ['institucional.json']);
});

test('does not alter the previous snapshot on unsafe or invalid responses', async t => {
  const { destination, ...options } = await fixture(t);
  await mkdir(path.dirname(destination));
  await writeFile(destination, 'unchanged\n');
  const validPage = page(event('11-11-2026', 'Vigente'));
  const responses = [
    async () => { throw new Error('network failure'); },
    async () => htmlResponse(validPage, { status: 503 }),
    async () => Response.redirect('https://other.example/'),
    async () => new Response(validPage, { headers: { 'content-type': 'application/json' } }),
    async () => htmlResponse(validPage, { headers: { 'content-length': '1048577' } }),
    async () => htmlResponse(new Uint8Array([0xff])),
    async () => htmlResponse('a'.repeat(1_048_577)),
    async () => htmlResponse('<h1>Service unavailable</h1>'),
    async () => htmlResponse(page(event('11-11-2026', 'Vigente') + event('31-11-2026', 'Inválido'))),
  ];
  for (const fetchImpl of responses) {
    await assert.rejects(buildAgendaSnapshot({ ...options, fetchImpl }), /snapshot was not changed/);
    assert.equal(await readFile(destination, 'utf8'), 'unchanged\n');
    assert.deepEqual(await readdir(path.dirname(destination)), ['institucional.json']);
  }
});

test('does not follow a symlinked agenda directory', async t => {
  const { destination, ...options } = await fixture(t);
  const linkedDirectory = await mkdtemp(path.join(tmpdir(), 'agenda-snapshot-linked-'));
  t.after(() => rm(linkedDirectory, { recursive: true, force: true }));
  await symlink(linkedDirectory, path.dirname(destination), 'dir');
  await assert.rejects(buildAgendaSnapshot({
    ...options,
    fetchImpl: async () => htmlResponse(page()),
  }), /must not be a symbolic link/);
  assert.deepEqual(await readdir(linkedDirectory), []);
});
