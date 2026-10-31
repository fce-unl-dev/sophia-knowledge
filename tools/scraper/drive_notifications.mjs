// Avisos por mail a quien subió un documento a Drive: qué problema tuvo y qué
// hacer la próxima vez, y cuándo quedó resuelto. Cierra el ciclo de mejora
// continua de la carga (ver docs/GUIA_CARGA_DRIVE.md).
//
// El repo es público: el estado de avisos solo guarda claves archivo + versión
// + tipo, nunca direcciones de mail.

export const GUIDE_URL = 'https://docs.google.com/document/d/1UY93r6PzMZYImEofNAdZLNId3JxaBIjhuI8leb9SSH4/edit';
const RETENTION_DAYS = 180;

export const noticeKey = (item, kind = item.kind) => `${item.id}:${item.modifiedTime}:${kind}`;

// Avisos de higiene: no impiden procesar, así que no generan "ya resuelto".
export const WARNING_KINDS = new Set(['carpeta-raiz', 'nombre-generico', 'posible-duplicado', 'datos-personales']);

function describe(item) {
  return [`• ${item.path}`, `  ${item.advice}`, item.webViewLink ? `  Archivo: ${item.webViewLink}` : null].filter(Boolean).join('\n');
}

function compose(name, problems, resolved) {
  const lines = [`Hola${name ? `, ${name.split(' ')[0]}` : ''}:`, ''];
  if (problems.length) {
    lines.push('Revisamos los documentos que subiste a la carpeta de Drive de Luca y estos necesitan un ajuste:', '');
    lines.push(...problems.map(describe), '');
    lines.push('Los que no se pudieron procesar no entran a Luca hasta que se corrijan; se reintentan solos todos los días.', '');
  }
  if (resolved.length) {
    lines.push('Estos documentos que tenían problemas ya se procesaron bien y quedaron propuestos para la base de Luca:', '');
    lines.push(...resolved.map((item) => `• ${item.path}`), '');
  }
  lines.push(`Guía para subir documentos: ${GUIDE_URL}`, '', 'Este mensaje es automático. Ante dudas, respondé a este correo.');
  return lines.join('\n');
}

// Arma un mensaje por persona con lo que todavía no se le avisó.
// `sent` es { clave: ISO }; devuelve los mensajes y el estado actualizado.
export function buildNotifications(report, sent = {}, now = new Date()) {
  const fresh = (item) => !sent[noticeKey(item)];
  const problems = [...(report.errors || []), ...(report.warnings || [])].filter(fresh);
  const warnedIds = new Set(Object.keys(sent)
    .map((key) => key.split(':'))
    .filter((parts) => parts.at(-1) !== 'resuelto' && !WARNING_KINDS.has(parts.at(-1)))
    .map(([id]) => id));
  const resolved = (report.processed || [])
    .filter((item) => warnedIds.has(item.id) && !sent[noticeKey(item, 'resuelto')]);

  const recipients = new Map();
  const add = (item, bucket) => {
    const email = item.uploader?.email || '';
    const entry = recipients.get(email) || { name: item.uploader?.name || '', problems: [], resolved: [] };
    entry[bucket].push(item);
    recipients.set(email, entry);
  };
  problems.forEach((item) => add(item, 'problems'));
  resolved.forEach((item) => add(item, 'resolved'));

  const messages = [...recipients].map(([email, { name, problems: own, resolved: fixed }]) => ({
    to: email || null,
    name,
    subject: own.length
      ? `Luca: ${own.length} documento(s) de Drive para revisar`
      : `Luca: ${fixed.length} documento(s) de Drive ya procesados`,
    text: compose(name, own, fixed),
    keys: [...own.map((item) => noticeKey(item)), ...fixed.map((item) => noticeKey(item, 'resuelto'))],
    paths: [...own, ...fixed].map((item) => item.path),
  }));

  const cutoff = now.getTime() - RETENTION_DAYS * 86400000;
  const kept = Object.fromEntries(Object.entries(sent).filter(([, at]) => Date.parse(at) >= cutoff));
  return { messages, state: kept };
}

export function markSent(state, message, now = new Date()) {
  return { ...state, ...Object.fromEntries(message.keys.map((key) => [key, now.toISOString()])) };
}
