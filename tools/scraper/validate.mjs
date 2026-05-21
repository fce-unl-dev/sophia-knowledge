// Validador de MDs candidatos. Aplica reglas estructurales (secciones del
// template, patrones prohibidos, placeholders, tamaño) y opcionalmente
// chequea URLs con HEAD. También corre validaciones semánticas ligeras
// (fechas pasadas, draft sin revisar) que generan warnings sin bloquear el PR.
//
// Uso CLI:
//   node validate.mjs --file=state/mba.candidate.md [--current=../posgrados/mba.md] [--skip-network]
//
// Exit codes:
//   0 = ok (puede haber warnings)
//   1 = errores estructurales bloqueantes
//   2 = error de invocación (args inválidos, archivo faltante)

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Secciones obligatorias en el orden exacto del template (template.md raíz del KB).
export const REQUIRED_SECTIONS = [
  'Identificación',
  'Modalidad y duración',
  'Plan de estudios',
  'Cuerpo docente',
  'Requisitos de admisión',
  'Aranceles e inscripción',
  'Próxima cohorte',
  'Contacto',
  'Información adicional relevante',
  'Fuentes consultadas',
];

export const PROHIBITED_PHRASES = [
  'Muchas gracias por tu interés',
  'Muchas gracias por su interés',
  'Quedamos a disposición',
  'Esperamos contar con su participación',
  'Es un placer informarle',
  'Es un placer informarte',
  'Reciba un cordial saludo',
];

// ---------- Checks (funciones puras) ----------

export function checkStructure(md) {
  const errors = [];
  const lines = md.split('\n');

  // H1 al principio (después de líneas vacías permitidas)
  const firstNonEmpty = lines.find((l) => l.trim() !== '');
  if (!firstNonEmpty || !firstNonEmpty.startsWith('# ')) {
    errors.push('Falta H1 al inicio del documento');
  }

  // Secciones presentes y en orden
  let cursor = 0;
  for (const section of REQUIRED_SECTIONS) {
    const re = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm');
    const m = re.exec(md.slice(cursor));
    if (!m) {
      errors.push(`Sección obligatoria faltante o fuera de orden: "## ${section}"`);
      // No avanzamos el cursor — si una sección falta, las siguientes se buscan desde el mismo punto
    } else {
      cursor += m.index + m[0].length;
    }
  }
  return errors;
}

export function checkProhibited(md) {
  const errors = [];
  for (const phrase of PROHIBITED_PHRASES) {
    if (md.includes(phrase)) errors.push(`Patrón prohibido: "${phrase}"`);
  }
  // Bloques de código markdown — no deberían existir en una ficha
  if (/^```/m.test(md)) errors.push('Contiene bloques de código markdown (```)');
  return errors;
}

export function checkPlaceholders(md) {
  const errors = [];
  // Placeholders típicos del template: {...} con palabras (no JSON real)
  const re = /\{[A-ZÁÉÍÓÚÑa-záéíóúñ][^{}\n]{2,80}\}/g;
  const matches = md.match(re) || [];
  // Filtrar matches que parezcan código real (paths absolutos con / dentro, etc.) — defensivo
  const placeholders = matches.filter((m) => !m.includes('/') && !m.includes('@'));
  for (const p of placeholders.slice(0, 5)) {
    errors.push(`Placeholder sin reemplazar: ${p}`);
  }
  if (placeholders.length > 5) errors.push(`... y ${placeholders.length - 5} placeholders más`);
  return errors;
}

export function checkClosing(md) {
  const errors = [];
  if (!/\*\*Última revisión humana\*\*/.test(md)) {
    errors.push('Falta línea de cierre "**Última revisión humana**:"');
  }
  return errors;
}

// Validaciones semánticas ligeras: detecta fechas pasadas y drafts sin revisar.
// Devuelve warnings (no errores bloqueantes).
export function checkSemanticDates(md, { today = new Date() } = {}) {
  const warnings = [];

  // 1. Avisar si el candidato es un draft autogenerado pendiente de revisión.
  if (/PENDIENTE — draft autogenerado/i.test(md)) {
    warnings.push('El candidato está marcado como draft autogenerado. Requiere revisión humana antes de publicar.');
  }

  // 2. Buscar fechas de inicio de cohorte en formatos conocidos.
  // Patrones cubiertos:
  //   **Fecha de inicio**: 2024-03-01
  //   **Fecha de inicio**: marzo de 2024
  //   **Fecha de inicio publicada**: 15/03/2024
  //   Próxima cohorte: 2024-03 (solo YYYY-MM)
  const DATE_PATTERNS = [
    // ISO: 2024-03-01 ó 2024-03
    /(\d{4})-(\d{2})(?:-(\d{2}))?/g,
    // DD/MM/YYYY
    /(\d{2})\/(\d{2})\/(\d{4})/g,
  ];

  // Solo chequeamos dentro de las secciones críticas.
  const CRITICAL_SECTIONS = ['Próxima cohorte', 'Aranceles e inscripción'];
  for (const section of CRITICAL_SECTIONS) {
    const sectionRe = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm');
    const sectionStart = md.search(sectionRe);
    if (sectionStart === -1) continue;
    // Recortar hasta el siguiente ## o final del doc
    const nextSectionMatch = /^##\s+/m.exec(md.slice(sectionStart + section.length + 3));
    const sectionEnd = nextSectionMatch
      ? sectionStart + section.length + 3 + nextSectionMatch.index
      : md.length;
    const sectionText = md.slice(sectionStart, sectionEnd);

    // Ignorar si la sección dice "No publicado" o "consultar" o "cerrada"
    if (/no publicado|consultar|cerrada|a confirmar|por confirmar/i.test(sectionText)) continue;

    // Buscar fechas ISO (YYYY-MM-DD o YYYY-MM)
    let isoMatch;
    const isoRe = /(\d{4})-(\d{2})(?:-(\d{2}))?/g;
    while ((isoMatch = isoRe.exec(sectionText)) !== null) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10) - 1;
      const day = isoMatch[3] ? parseInt(isoMatch[3], 10) : 28; // fin de mes si no hay día
      if (year < 2000 || year > 2100) continue; // descarto rangos inválidos
      const found = new Date(year, month, day);
      if (found < today) {
        warnings.push(
          `Fecha aparentemente vencida en «## ${section}»: ${isoMatch[0]}. Verificar si la cohorte fue actualizada.`,
        );
      }
    }

    // Buscar fechas DD/MM/YYYY
    let dmyMatch;
    const dmyRe = /(\d{2})\/(\d{2})\/(\d{4})/g;
    while ((dmyMatch = dmyRe.exec(sectionText)) !== null) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10) - 1;
      const year = parseInt(dmyMatch[3], 10);
      if (year < 2000 || year > 2100) continue;
      const found = new Date(year, month, day);
      if (found < today) {
        warnings.push(
          `Fecha aparentemente vencida en «## ${section}»: ${dmyMatch[0]}. Verificar si la cohorte fue actualizada.`,
        );
      }
    }
  }

  return warnings;
}

export function checkSize(candidateMd, currentMd, { minRatio = 0.3, maxRatio = 3.0 } = {}) {
  const warnings = [];
  const errors = [];
  if (!currentMd) return { errors, warnings, ratio: null };
  const ratio = candidateMd.length / currentMd.length;
  if (ratio < minRatio) {
    errors.push(`Candidato muy chico vs MD actual: ${(ratio * 100).toFixed(0)}% (umbral ${(minRatio * 100).toFixed(0)}%)`);
  } else if (ratio > maxRatio) {
    warnings.push(`Candidato mucho más grande que MD actual: ${(ratio * 100).toFixed(0)}% (umbral ${(maxRatio * 100).toFixed(0)}%)`);
  }
  return { errors, warnings, ratio };
}

// Extrae URLs de la sección "Fuentes consultadas" (la última sección).
export function extractFontsUrls(md) {
  const idx = md.search(/^##\s+Fuentes consultadas\s*$/m);
  if (idx === -1) return [];
  const section = md.slice(idx);
  const urls = new Set();
  const re = /https?:\/\/[^\s)<>"'`]+[^\s)<>"'`.,;:]/g;
  let m;
  while ((m = re.exec(section)) !== null) urls.add(m[0]);
  return Array.from(urls);
}

// ---------- Network check (async) ----------

export async function checkUrls(urls, { fetchImpl = fetch, timeoutMs = 8000, concurrency = 5 } = {}) {
  const failed = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const url = urls[idx];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        if (!res.ok && res.status !== 405) {
          // 405 = método no permitido pero la URL existe; aceptamos
          failed.push({ url, status: res.status });
        }
      } catch (err) {
        failed.push({ url, error: String(err.name || err.message || err) });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return failed;
}

// ---------- Orchestrator ----------

export async function validate(md, { currentMd = '', skipNetwork = false, fetchImpl = fetch, today = new Date() } = {}) {
  const errors = [];
  const warnings = [];

  errors.push(...checkStructure(md));
  errors.push(...checkProhibited(md));
  errors.push(...checkPlaceholders(md));
  errors.push(...checkClosing(md));

  // Validaciones semánticas: fechas pasadas y estado de draft
  warnings.push(...checkSemanticDates(md, { today }));

  const size = checkSize(md, currentMd);
  errors.push(...size.errors);
  warnings.push(...size.warnings);

  let urlsChecked = 0;
  let failedUrls = [];
  if (!skipNetwork) {
    const urls = extractFontsUrls(md);
    urlsChecked = urls.length;
    failedUrls = await checkUrls(urls, { fetchImpl });
    // URL faltante o 4xx/5xx → warning, no error bloqueante: el LLM puede haber
    // copiado bien pero la URL ya estaba muerta antes.
    for (const f of failedUrls) {
      warnings.push(`URL inválida en Fuentes consultadas: ${f.url} (${f.status || f.error})`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks: {
      structure_sections_required: REQUIRED_SECTIONS.length,
      size_ratio: size.ratio,
      urls_checked: urlsChecked,
      urls_failed: failedUrls.length,
      semantic_warnings: warnings.filter((w) => w.includes('vencida') || w.includes('draft')).length,
    },
  };
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      current: { type: 'string' },
      'skip-network': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || !values.file) {
    console.log(`Sophia KB validator

Uso:
  node validate.mjs --file=state/mba.candidate.md [--current=../posgrados/mba.md] [--skip-network]

Exit codes: 0=ok, 1=errores, 2=invocación inválida.
`);
    process.exit(values.help ? 0 : 2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(here, values.file);
  if (!existsSync(filePath)) {
    console.error(`Archivo no existe: ${filePath}`);
    process.exit(2);
  }
  const md = await readFile(filePath, 'utf8');
  let currentMd = '';
  if (values.current) {
    const curPath = resolve(here, values.current);
    if (existsSync(curPath)) currentMd = await readFile(curPath, 'utf8');
  }

  const result = await validate(md, { currentMd, skipNetwork: values['skip-network'] });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
