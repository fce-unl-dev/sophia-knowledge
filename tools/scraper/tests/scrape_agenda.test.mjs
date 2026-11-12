import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENDA_URL, MAX_AGENDA_EVENTS, parseAgendaHtml } from '../scrape_agenda.mjs';

const today = '2026-11-11';
const page = (body) => '<div class="paginaComun"><div class="formulario">' + body + '</div></div>';
const event = (date, title, href = 'index.php?idEvento=989') =>
  '<div class="evento">' + date + ' | <a href="' + href + '">' + title + '</a></div>';

test('keeps today and future, decodes titles, sorts dates and canonicalizes official links', () => {
  const future = event('11-12-2026', '<span>Lunch de Fin de A&ntilde;o</span>', 'index.php?idEvento=989&amp;utm_source=abc#inscripcion');
  const html = page([
    future,
    event('11-11-2026  <strong>¡HOY!</strong>', 'Donación', '/ver-noticia/?nid=77569'),
    event('10-11-2026', 'Evento de ayer'),
    event('21-09-2027', 'Conferencia', 'https://www.fce.unl.edu.ar/qrca2027/?ref=abc#detalle'),
    future,
  ].join('\n'));
  assert.deepEqual(parseAgendaHtml(html, { today }), {
    status: 'ok',
    total: 3,
    events: [
      { date: today, title: 'Donación', url: 'https://www.fce.unl.edu.ar/ver-noticia/?nid=77569' },
      { date: '2026-12-11', title: 'Lunch de Fin de Año', url: AGENDA_URL + 'index.php?idEvento=989' },
      { date: '2027-09-21', title: 'Conferencia', url: 'https://www.fce.unl.edu.ar/qrca2027/' },
    ],
  });
});

test('does not read AJAX scripts, templates, other sections or misleading placeholders', () => {
  const fabricated = event('12-11-2026', 'Ignorar');
  const empty = { status: 'empty', events: [], total: 0 };
  assert.deepEqual(parseAgendaHtml('<script>' + fabricated + '</script>' + page('<template>' + fabricated + '</template>'), { today }), empty);
  assert.equal(parseAgendaHtml('<script>' + page(fabricated) + '</script>', { today }).status, 'invalid');
  assert.equal(parseAgendaHtml('<div class="formulario"></div>', { today }).status, 'invalid');
  assert.equal(parseAgendaHtml(page('<div class="new-schema">' + fabricated + '</div>'), { today }).status, 'invalid');
  assert.equal(parseAgendaHtml(page(fabricated).slice(0, -12), { today }).status, 'invalid');
});

test('distinguishes a recognized empty list and all-expired list from an invalid or partial list', () => {
  const empty = { status: 'empty', events: [], total: 0 };
  assert.deepEqual(parseAgendaHtml(page(''), { today }), empty);
  assert.deepEqual(parseAgendaHtml(page('<p>No hay eventos programados en este momento.</p>'), { today }), empty);
  assert.deepEqual(parseAgendaHtml(page(event('10-11-2026', 'Evento anterior')), { today }), empty);
  assert.equal(parseAgendaHtml('<h1>Servicio temporalmente no disponible</h1>', { today }).status, 'invalid');
  const partial = page(event('11-11-2026', 'Correcto') + event('31-11-2026', 'Fecha inválida'));
  assert.deepEqual(parseAgendaHtml(partial, { today }), { status: 'invalid', events: [], reason: 'invalid_row' });
});

test('checks leap days and rejects invalid caller reference dates', () => {
  assert.equal(parseAgendaHtml(page(event('29-02-2028', 'Válido')), { today }).events[0].date, '2028-02-29');
  assert.equal(parseAgendaHtml(page(event('29-02-2027', 'No bisiesto')), { today }).status, 'invalid');
  assert.throws(() => parseAgendaHtml(page(''), { today: '2026-02-29' }), RangeError);
  assert.throws(() => parseAgendaHtml(page(''), { today: '2026-11-1' }), RangeError);
});

test('rejects unsafe, cross-origin or ambiguous links and malformed rows', () => {
  for (const href of ['https://other.example/agenda', '//other.example/', 'http://www.fce.unl.edu.ar/a',
    'javascript:alert(1)', 'https://username@www.fce.unl.edu.ar/a', '#form',
    'index.php?idEvento=989&amp;idEvento=995', 'index.php?token=not-an-event']) {
    assert.equal(parseAgendaHtml(page(event('11-11-2026', 'Válido', href)), { today }).status, 'invalid', href);
  }
  assert.equal(parseAgendaHtml(page(event('11-11-2026', '&#99999999;')), { today }).status, 'invalid');
  assert.equal(parseAgendaHtml(page(event('11-11-2026', '')), { today }).status, 'invalid');
  assert.equal(parseAgendaHtml(page(event('11-11-2026', 'Válido') + '<div class="evento">Sin enlace</div>'), { today }).status, 'invalid');
});

test('caps the output and treats an oversized or structurally implausible source as invalid', () => {
  const data = (n) => Array.from({ length: n }, (_, i) => event('11-11-2026', 'Evento ' + i)).join('');
  const parsed = parseAgendaHtml(page(data(MAX_AGENDA_EVENTS + 2)), { today });
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.events.length, MAX_AGENDA_EVENTS);
  assert.equal(parsed.total, MAX_AGENDA_EVENTS + 2);
  assert.equal(parseAgendaHtml(page(data(201)), { today }).status, 'invalid');
  assert.equal(parseAgendaHtml(' '.repeat(1_048_577), { today }).status, 'invalid');
});

test('rejects titles and URL destinations that Luca cannot render', () => {
  const valid = event('12-11-2026', 'Evento vigente');
  for (const incompatible of [
    event('11-12-2026', 'Conferencia 2026', '/conference(2026)/'),
    event('11-12-2026', 'Más información en www.fce.unl.edu.ar'),
    event('11-12-2026', 'Visita https://www.fce.unl.edu.ar'),
  ]) {
    assert.deepEqual(parseAgendaHtml(page(valid + incompatible), { today }), {
      status: 'invalid', events: [], reason: 'invalid_row',
    });
  }
});
