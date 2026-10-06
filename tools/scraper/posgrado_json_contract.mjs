// Boundary contract for the three official FCE postgraduate JSON feeds.
// Parsing never publishes, deletes, or infers an FAQ category from its text.
import { createHash } from 'node:crypto';

const ORIGINS = {
  basicos: 'fce_unl_faq_generales',
  carreras: 'fce_unl_carreras_posgrado',
  cursos: 'fce_unl_cursos_posgrado',
};
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

export class FeedContractError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'FeedContractError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new FeedContractError(code, detail);
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape', label);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_field', label);
  return value;
}

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_id', label);
  return value;
}

function localDate(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_date', label);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail('invalid_date', label);
  }
  return value;
}

export function artTimestamp(value, label = 'timestamp', now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    fail('invalid_timestamp', label);
  }
  const [day, time] = value.split(' ');
  localDate(day, label);
  const [hh, mm, ss] = time.split(':').map(Number);
  if (hh > 23 || mm > 59 || ss > 59) fail('invalid_timestamp', label);
  // The CRM timestamps are naive local times; all three feeds use Argentina time (UTC-03).
  const epochMs = Date.parse(`${day}T${time}Z`) + ART_OFFSET_MS;
  if (!Number.isFinite(epochMs) || epochMs > now + 5 * 60 * 1000) fail('future_timestamp', label);
  return epochMs;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function validateEnrollment(value, label, generatedAtMs) {
  const enrollment = object(value, `${label}.inscripcion`);
  if (!['ABIERTA', 'CERRADA'].includes(enrollment.estado) ||
      typeof enrollment.esta_abierta !== 'boolean' ||
      enrollment.esta_abierta !== (enrollment.estado === 'ABIERTA')) {
    fail('invalid_enrollment', label);
  }
  localDate(enrollment.fecha_limite, `${label}.inscripcion.fecha_limite`);
  if (enrollment.estado === 'ABIERTA' && enrollment.fecha_limite === null) fail('invalid_enrollment', label);
  const generatedLocalDay = new Date(generatedAtMs - ART_OFFSET_MS).toISOString().slice(0, 10);
  if (enrollment.estado === 'ABIERTA' && enrollment.fecha_limite < generatedLocalDay) {
    fail('expired_open_enrollment', label);
  }
}

function validateRecord(kind, record, index, now, generatedAtMs) {
  const label = `${kind}[${index}]`;
  object(record, label);
  const id = positiveId(record.id_posgrado, `${label}.id_posgrado`);
  if (kind === 'carreras') positiveId(record.id_carrera, `${label}.id_carrera`);
  if (record.tipo !== (kind === 'carreras' ? 'Posgrado' : 'Curso')) fail('invalid_field', `${label}.tipo`);
  if (kind === 'carreras') text(record.subtipo, `${label}.subtipo`);
  else if (record.subtipo !== null && typeof record.subtipo !== 'string') fail('invalid_field', `${label}.subtipo`);
  text(record.nombre, `${label}.nombre`);
  text(record.respuesta_frecuente, `${label}.respuesta_frecuente`);
  const url = text(record.url_sitio_web, `${label}.url_sitio_web`);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) fail('invalid_url', label);
  } catch { fail('invalid_url', label); }
  validateEnrollment(record.inscripcion, label, generatedAtMs);
  const updatedAtMs = artTimestamp(record.fecha_actualizacion, `${label}.fecha_actualizacion`, now);
  if (updatedAtMs > generatedAtMs) fail('update_after_generation', label);
  const { fecha_actualizacion, ...content } = record;
  return { id: `${kind}:${id}`, updatedAt: fecha_actualizacion, updatedAtMs,
    contentHash: contentHash(content), data: record,
    faqSelectionProvenance: 'not_provided' };
}

export function parsePosgradoFeed(kind, input, { now = Date.now() } = {}) {
  if (!Object.hasOwn(ORIGINS, kind)) fail('invalid_kind', String(kind));
  let feed;
  try { feed = typeof input === 'string' ? JSON.parse(input) : input; }
  catch { fail('invalid_json', kind); }
  object(feed, kind);
  if (feed.schema_version !== 1) fail('unsupported_schema', kind);
  if (feed.origen !== ORIGINS[kind]) fail('invalid_origin', kind);
  const generatedAtMs = artTimestamp(feed.fecha_generacion, `${kind}.fecha_generacion`, now);
  if (kind === 'basicos') {
    const id = positiveId(feed.faq_id, 'basicos.faq_id');
    const updatedAtMs = artTimestamp(feed.fecha_actualizacion, 'basicos.fecha_actualizacion', now);
    if (updatedAtMs > generatedAtMs) fail('update_after_generation', 'basicos');
    if (!Array.isArray(feed.secciones) || feed.secciones.length === 0) fail('invalid_shape', 'basicos.secciones');
    feed.secciones.forEach((section, index) => {
      const label = `basicos.secciones[${index}]`;
      object(section, label);
      text(section.titulo, `${label}.titulo`);
      text(section.contenido_completo, `${label}.contenido_completo`);
      if (!Array.isArray(section.items) || section.items.length === 0) fail('invalid_shape', `${label}.items`);
      section.items.forEach((item, itemIndex) => text(item, `${label}.items[${itemIndex}]`));
    });
    const data = { faq_id: id, secciones: feed.secciones };
    return { kind, generatedAt: feed.fecha_generacion, generatedAtMs,
      records: [{ id: `basicos:${id}`, updatedAt: feed.fecha_actualizacion, updatedAtMs,
        contentHash: contentHash(data), data, faqSelectionProvenance: 'not_provided' }] };
  }
  const records = feed[kind];
  if (!Array.isArray(records) || records.length === 0) fail('invalid_shape', `${kind}.${kind}`);
  if (feed.cantidad_registros !== undefined &&
      (!Number.isSafeInteger(feed.cantidad_registros) || feed.cantidad_registros !== records.length)) {
    fail('count_mismatch', kind);
  }
  const parsed = records.map((record, index) => validateRecord(kind, record, index, now, generatedAtMs));
  const ids = new Set();
  for (const record of parsed) {
    if (ids.has(record.id)) fail('duplicate_id', record.id);
    ids.add(record.id);
  }
  return { kind, generatedAt: feed.fecha_generacion, generatedAtMs, records: parsed };
}

// Issues are quarantine signals for the caller, never permission to delete or publish.
export function compareFeedSnapshots(previous, current) {
  if (previous.kind !== current.kind) fail('kind_mismatch', `${previous.kind}/${current.kind}`);
  const next = new Map(current.records.map(record => [record.id, record]));
  const issues = [];
  for (const record of previous.records) {
    const candidate = next.get(record.id);
    if (!candidate) issues.push({ code: 'missing_record', id: record.id });
    else if (candidate.updatedAtMs < record.updatedAtMs) issues.push({ code: 'timestamp_regression', id: record.id });
    else if (candidate.updatedAtMs === record.updatedAtMs && candidate.contentHash !== record.contentHash) {
      issues.push({ code: 'content_changed_without_revision', id: record.id });
    }
  }
  return issues;
}
