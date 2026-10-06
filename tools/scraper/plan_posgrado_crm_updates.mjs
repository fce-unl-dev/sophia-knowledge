// Pure proposal boundary: official CRM text is data, never a routing instruction.
import routesDefault from './posgrado_crm_routes.json' with { type: 'json' };
import { parsePosgradoFeed } from './posgrado_json_contract.mjs';

const BEGIN = '<!-- posgrado-crm:begin -->';
const END = '<!-- posgrado-crm:end -->';
const QUARANTINE_REASONS = new Set([
  'faq_start_date_conflicts_with_academic_pdf',
  'faq_degree_or_admission_conflicts_with_academic_source',
  'faq_specialization_count_conflicts_with_academic_source',
  'faq_timetable_conflicts_with_academic_source',
  'faq_delivery_mode_conflicts_with_academic_source',
]);
const BLOCK = /^<!-- posgrado-crm:begin -->\n<!-- posgrado-crm:id (carreras|cursos):([1-9]\d*) -->\n[\s\S]*?^<!-- posgrado-crm:end -->/gm;
const DYNAMIC_HEADING = /^(?:aranceles?|precios?|inscripci[oó]n|pr[oó]xima cohorte|matr[ií]cula)(?:\b|$)|^costos?(?:$|\s+(?:e?\s*inscripci[oó]n|y\s+(?:aranceles|financiaci[oó]n)|del?\s+(?:curso|programa|posgrado|carrera))\b)/i;
const DYNAMIC_LABEL = /^(?:aranceles?|costos?|precios?|cuotas?|matr[ií]cula|estado(?: actual)? de inscripci[oó]n|estado de (?:la )?pr[oó]xima cohorte|fecha l[ií]mite(?: de inscripci[oó]n)?|fecha de (?:inicio|cierre|apertura)(?: de inscripci[oó]n)?|link de preinscripci[oó]n|link de pre-inscripci[oó]n|fuente del estado de inscripci[oó]n|[uú]ltima actualizaci[oó]n del dato de inscripci[oó]n)(?:\s*\([^)]*\))?$/i;
const DYNAMIC_PROSE = /\b(?:ARS|USD)\s*(?:\$\s*)?\d|(?:\$\s*)?\d[\d.,]*\s*(?:pesos|d[oó]lares)\b|\b(?:arancel|precio|costo|cuota|matr[ií]cula)\b[^\n]{0,60}?(?:\$\s*\d|\b(?:ARS|USD)\b)|\binscripci[oó]n\s+(?:(?:figura|est[aá])\s+)?(?:abierta|cerrada|vencida)\b|\bfecha\s+l[ií]mite\s+(?:de\s+)?inscripci[oó]n\b/i;

function hasLegacyDynamicClaims(content) {
  return content.split(/\r?\n/).some(rawLine => {
    const line = rawLine.replace(/^\s*(?:>\s*)?(?:[-*+]\s+)?/, '')
      .replace(/[*_`]/g, '').trim().replace(/\s+/g, ' ');
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading && DYNAMIC_HEADING.test(heading[1])) return true;
    const label = line.match(/^([^:]{1,120}):/);
    if (label && DYNAMIC_LABEL.test(label[1].trim())) return true;
    if (/^estado\s*:/.test(line.toLowerCase()) && /\b(?:inscripci[oó]n|cohorte|edici[oó]n|abierta|cerrada|vencida)\b/i.test(line)) return true;
    return DYNAMIC_PROSE.test(line);
  });
}

function markdownData(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

function quoteData(value) {
  return markdownData(value).split('\n').map(rawLine => {
    const line = rawLine.trimEnd();
    return line ? `> ${line}` : '>';
  }).join('\n');
}

function render(record) {
  const item = record.data;
  const open = item.inscripcion.estado === 'ABIERTA';
  const deadline = item.inscripcion.fecha_limite ?? 'No informada';
  const courseEnrollment = open && record.id.startsWith('cursos:')
    ? `- **Preinscripción directa:** https://www.fce.unl.edu.ar/posgrados/index.php?act=showLogin&id_posgrado=${item.id_posgrado}\n`
    : '';
  const historical = open ? '' : '\n> **Aviso:** inscripción cerrada. Si la respuesta menciona aranceles, corresponden a una cohorte anterior; no presentarlos como precios vigentes. Los enlaces e indicaciones de inscripción de esa respuesta corresponden a la cohorte cerrada; no ofrecerlos como vías de inscripción actualmente habilitadas.\n';
  return `${BEGIN}\n<!-- posgrado-crm:id ${record.id} -->\n` +
    `### Información oficial del CRM — ${markdownData(item.nombre)}\n\n` +
    `- **ID de propuesta:** ${item.id_posgrado}\n` +
    `- **Inscripción:** ${open ? 'Abierta' : 'Cerrada'}\n` +
    `- **Fecha límite de inscripción:** ${deadline}\n` +
    courseEnrollment +
    `- **Última actualización de este registro (Argentina):** ${record.updatedAt}\n` +
    `${historical}\n**Respuesta frecuente oficial (dato del CRM):**\n\n` +
    `${quoteData(item.respuesta_frecuente)}\n${END}`;
}

function validateRoutes(routes, index, documents) {
  const issues = [];
  const indexed = new Set(Array.isArray(index?.items) ? index.items.map(item => item.path) : []);
  if (routes?.version !== 1 || !indexed?.size ||
      routes.basicos?.target !== 'posgrado-general/datos-para-crawler.md' ||
      routes.basicos?.mode !== 'deferred_until_equivalence_verified') {
    return [{ code: 'invalid_manifest' }];
  }
  for (const kind of ['carreras', 'cursos']) {
    if (!routes[kind] || typeof routes[kind] !== 'object' || Array.isArray(routes[kind]) ||
        Object.keys(routes[kind]).length === 0) {
      issues.push({ code: 'invalid_manifest', kind });
      continue;
    }
    const careerPaths = new Map();
    for (const [id, target] of Object.entries(routes[kind])) {
      const path = kind === 'carreras' ? target?.[0] : target;
      const careerId = kind === 'carreras' ? target?.[1] : null;
      const permitted = kind === 'cursos' ? /^cursos-posgrado\/[a-z0-9-]+\.md$/.test(path) :
        /^(?:posgrados|diplomaturas|compartidos)\/[a-z0-9-]+\.md$/.test(path);
      if (!/^[1-9]\d*$/.test(id) || !permitted || !indexed.has(path) ||
          typeof documents?.[path] !== 'string' ||
          (kind === 'carreras' && (!Array.isArray(target) || target.length !== 2 ||
            !Number.isSafeInteger(careerId) || careerId <= 0))) {
        issues.push({ code: 'invalid_mapping', id: `${kind}:${id}` });
      }
      if (kind === 'carreras' && typeof path === 'string') {
        const priorCareerId = careerPaths.get(path);
        if (priorCareerId !== undefined && priorCareerId !== careerId) {
          issues.push({ code: 'ambiguous_mapping', id: `${kind}:${id}`, path });
        }
        careerPaths.set(path, careerId);
      }
    }
  }
  if (routes.quarantined !== undefined) {
    if (!routes.quarantined || typeof routes.quarantined !== 'object' ||
        Array.isArray(routes.quarantined)) {
      issues.push({ code: 'invalid_quarantine' });
    } else {
      for (const [id, reason] of Object.entries(routes.quarantined)) {
        const match = id.match(/^(carreras|cursos):([1-9]\d*)$/);
        if (!match || !Object.hasOwn(routes[match[1]] ?? {}, match[2]) ||
            !QUARANTINE_REASONS.has(reason)) {
          issues.push({ code: 'invalid_quarantine', id });
        }
      }
    }
  }
  return issues;
}

function inspectBlocks(content, path, routes, { allowLegacyClaims = false } = {}) {
  const blocks = [...content.matchAll(BLOCK)];
  const beginCount = content.split(BEGIN).length - 1;
  const endCount = content.split(END).length - 1;
  if (blocks.length !== beginCount || blocks.length !== endCount) return { code: 'malformed_blocks', path };
  const ids = new Set();
  for (const block of blocks) {
    const id = `${block[1]}:${block[2]}`;
    const target = routes[block[1]]?.[block[2]];
    const mappedPath = block[1] === 'carreras' ? target?.[0] : target;
    if (ids.has(id) || mappedPath !== path) return { code: 'ambiguous_block', path, id };
    ids.add(id);
  }
  const outside = content.replace(BLOCK, '');
  if (!allowLegacyClaims && hasLegacyDynamicClaims(outside)) return { code: 'legacy_dynamic_claims', path };
  return { blocks, ids };
}

/**
 * Proposes in-memory updates only. Callers must reject publication when anomalies exist;
 * comparison with a persisted previous feed snapshot is a separate required gate.
 */
export function planPosgradoCrmUpdates({ rawFeeds, index, documents, routes = routesDefault, now = Date.now() }) {
  const anomalies = validateRoutes(routes, index, documents);
  const result = { updates: [], anomalies, skipped: [], quarantined: [], deferred: [{
    kind: 'basicos', target: routes?.basicos?.target,
    reason: 'equivalence_with_curated_general_document_not_verified',
  }] };
  if (anomalies.length) return result;

  const parsed = Object.fromEntries(['basicos', 'carreras', 'cursos'].map(kind => {
    // The published contract validates the raw external JSON before any planning.
    if (typeof rawFeeds?.[kind] !== 'string') throw new TypeError(`rawFeeds.${kind} must be raw JSON text`);
    return [kind, parsePosgradoFeed(kind, rawFeeds[kind], { now })];
  }));
  const grouped = new Map();
  const quarantinedPaths = new Set();
  for (const kind of ['carreras', 'cursos']) {
    const seen = new Set();
    for (const record of parsed[kind].records) {
      const id = String(record.data.id_posgrado);
      seen.add(id);
      const target = routes[kind][id];
      if (!target) {
        (record.data.inscripcion.esta_abierta ? anomalies : result.skipped).push({
          code: record.data.inscripcion.esta_abierta ? 'unknown_open_id' : 'unmapped_closed_id', id: record.id,
        });
        continue;
      }
      const path = kind === 'carreras' ? target[0] : target;
      if (kind === 'carreras' && record.data.id_carrera !== target[1]) {
        anomalies.push({ code: 'career_identity_mismatch', id: record.id });
        continue;
      }
      const reason = routes.quarantined?.[record.id];
      if (reason) {
        result.quarantined.push({ id: record.id, path, reason });
        quarantinedPaths.add(path);
        continue;
      }
      if (!grouped.has(path)) grouped.set(path, []);
      grouped.get(path).push(record);
    }
    for (const id of Object.keys(routes[kind])) {
      if (!seen.has(id)) anomalies.push({ code: 'missing_mapped_record', id: `${kind}:${id}` });
    }
  }
  for (const path of quarantinedPaths) {
    const inspection = inspectBlocks(documents[path], path, routes, { allowLegacyClaims: true });
    if (inspection.code) anomalies.push(inspection);
  }
  for (const [path, records] of grouped) {
    if (quarantinedPaths.has(path)) {
      result.skipped.push({ code: 'shares_quarantined_path', path,
        ids: records.map(record => record.id) });
      continue;
    }
    const original = documents[path];
    const inspection = inspectBlocks(original, path, routes);
    if (inspection.code) { anomalies.push(inspection); continue; }
    let content = original;
    for (const record of records.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
      const replacement = render(record);
      const existing = inspection.blocks.find(block => `${block[1]}:${block[2]}` === record.id);
      if (existing) content = content.replace(existing[0], replacement);
      else content = `${content.trimEnd()}\n\n${replacement}\n`;
    }
    if (content !== original) result.updates.push({ path, content, ids: records.map(record => record.id) });
  }
  // A careless caller cannot publish a partial update while another route is anomalous.
  if (anomalies.length) result.updates = [];
  return result;
}
