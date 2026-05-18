// Validador de MDs candidatos. Aplica reglas estructurales (secciones del
// template, patrones prohibidos, placeholders, tamaño) y opcionalmente
// chequea URLs con HEAD.
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

export async function validate(md, { currentMd = '', skipNetwork = false, fetchImpl = fetch } = {}) {
  const errors = [];
  const warnings = [];

  errors.push(...checkStructure(md));
  errors.push(...checkProhibited(md));
  errors.push(...checkPlaceholders(md));
  errors.push(...checkClosing(md));

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
