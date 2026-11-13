import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAgendaUpdate, formatAgendaPrBody } from '../evaluate_agenda_update.mjs';

const ev = (date, id, title = `Evento ${id}`) => ({
  date,
  title,
  url: `https://www.fce.unl.edu.ar/eventos/index.php?idEvento=${id}`,
});

test('auto_merge when refreshing timestamp, adding events, or removing naturally expired events', () => {
  const previous = {
    events: [ev('2026-11-11', 1), ev('2026-11-15', 2), ev('2026-12-11', 3)],
  };
  const candidate = {
    events: [ev('2026-11-15', 2, 'Evento 2 actualizado'), ev('2026-12-11', 3), ev('2026-12-20', 4)],
  };

  const result = evaluateAgendaUpdate({ previous, candidate, today: '2026-11-12' });
  assert.equal(result.decision, 'auto_merge');
  assert.equal(result.added.length, 1);
  assert.equal(result.updated.length, 1);
  assert.equal(result.expiredRemoved.length, 1);
  assert.equal(result.activeRemoved.length, 0);
});

test('requires_review when all active events suddenly disappear to zero', () => {
  const previous = {
    events: [ev('2026-11-15', 2), ev('2026-12-11', 3)],
  };
  const candidate = { events: [] };

  const result = evaluateAgendaUpdate({ previous, candidate, today: '2026-11-12' });
  assert.equal(result.decision, 'requires_review');
  assert.match(result.reason, /vacía/i);
});

test('requires_review when 2 or more future events are removed before their date', () => {
  const previous = {
    events: [ev('2026-11-15', 2), ev('2026-11-20', 3), ev('2026-12-11', 4)],
  };
  const candidate = {
    events: [ev('2026-12-11', 4)],
  };

  const result = evaluateAgendaUpdate({ previous, candidate, today: '2026-11-12' });
  assert.equal(result.decision, 'requires_review');
  assert.equal(result.activeRemoved.length, 2);
});

test('formatAgendaPrBody renders diff summary cleanly', () => {
  const report = evaluateAgendaUpdate({
    previous: { events: [ev('2026-11-15', 2)] },
    candidate: { events: [ev('2026-11-15', 2), ev('2026-12-11', 3)] },
    today: '2026-11-12',
  });
  const body = formatAgendaPrBody(report, { refreshedAt: '2026-11-12T10:17:00Z', triggeredBy: 'cron' });
  assert.match(body, /auto_merge/);
  assert.match(body, /Agregados \(1\)/);
  assert.match(body, /idEvento=3/);
});
