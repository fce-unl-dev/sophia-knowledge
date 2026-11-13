import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function eventKey(event) {
  return `${event.date}|${event.url}`;
}

export function evaluateAgendaUpdate({ previous, candidate, today }) {
  const prevEvents = Array.isArray(previous?.events) ? previous.events : [];
  const nextEvents = Array.isArray(candidate?.events) ? candidate.events : [];

  const prevByKey = new Map(prevEvents.map((e) => [eventKey(e), e]));
  const nextByKey = new Map(nextEvents.map((e) => [eventKey(e), e]));

  const added = nextEvents.filter((e) => !prevByKey.has(eventKey(e)));
  const updated = nextEvents.filter((e) => {
    const prev = prevByKey.get(eventKey(e));
    return prev && prev.title !== e.title;
  });
  const removed = prevEvents.filter((e) => !nextByKey.has(eventKey(e)));
  const expiredRemoved = removed.filter((e) => typeof today === 'string' && e.date < today);
  const activeRemoved = removed.filter((e) => !(typeof today === 'string' && e.date < today));

  const prevActiveCount = prevEvents.filter((e) => !(typeof today === 'string' && e.date < today)).length;

  let decision = 'auto_merge';
  let reason = 'Validación determinística OK y sin bajas anómalas de eventos vigentes.';

  if (prevActiveCount >= 2 && nextEvents.length === 0) {
    decision = 'requires_review';
    reason = `La agenda quedó vacía (0 eventos) cuando había ${prevActiveCount} eventos vigentes.`;
  } else if (activeRemoved.length >= 2 && nextEvents.length < prevEvents.length) {
    decision = 'requires_review';
    reason = `Desaparecieron ${activeRemoved.length} eventos con fecha vigente antes de su realización.`;
  }

  return {
    decision,
    reason,
    prevCount: prevEvents.length,
    nextCount: nextEvents.length,
    added,
    updated,
    expiredRemoved,
    activeRemoved,
  };
}

export function formatAgendaPrBody(report, { refreshedAt, triggeredBy = 'cron automático' } = {}) {
  const lines = [
    'Actualización automática diaria de `agenda/institucional.json`.',
    '',
    `**Disparado por:** ${triggeredBy}`,
    `**refreshedAt:** \`${refreshedAt || 'N/D'}\``,
    `**Eventos:** ${report.prevCount} → ${report.nextCount}`,
    `**Decisión:** \`${report.decision}\``,
    `**Motivo:** ${report.reason}`,
    '',
    '## Cambios detectados',
    '',
    `- **Agregados (${report.added.length}):** ${report.added.length ? '' : 'ninguno.'}`,
  ];
  for (const e of report.added) {
    lines.push(`  - \`${e.date}\` — ${e.title} (${e.url})`);
  }
  lines.push(`- **Modificados (${report.updated.length}):** ${report.updated.length ? '' : 'ninguno.'}`);
  for (const e of report.updated) {
    lines.push(`  - \`${e.date}\` — ${e.title} (${e.url})`);
  }
  lines.push(`- **Vencidos por fecha (${report.expiredRemoved.length}):** ${report.expiredRemoved.length ? '' : 'ninguno.'}`);
  for (const e of report.expiredRemoved) {
    lines.push(`  - \`${e.date}\` — ${e.title}`);
  }
  lines.push(`- **Quitados con fecha vigente (${report.activeRemoved.length}):** ${report.activeRemoved.length ? '' : 'ninguno.'}`);
  for (const e of report.activeRemoved) {
    lines.push(`  - \`${e.date}\` — ${e.title} (${e.url})`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const idx = a.indexOf('=');
      return idx === -1 ? [a.replace(/^--/, ''), 'true'] : [a.slice(0, idx).replace(/^--/, ''), a.slice(idx + 1)];
    }),
  );

  const prevPath = path.resolve(args.prev || 'agenda/institucional.prev.json');
  const nextPath = path.resolve(args.next || 'agenda/institucional.json');
  const previous = JSON.parse(await readFile(prevPath, 'utf8'));
  const candidate = JSON.parse(await readFile(nextPath, 'utf8'));
  const today = String(candidate.refreshedAt || new Date().toISOString()).slice(0, 10);
  const report = evaluateAgendaUpdate({ previous, candidate, today });
  const body = formatAgendaPrBody(report, {
    refreshedAt: candidate.refreshedAt,
    triggeredBy: args['triggered-by'] || 'cron automático',
  });

  if (args['body-out']) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.resolve(args['body-out']), body, 'utf8');
  }
  console.log(JSON.stringify(report));
}
