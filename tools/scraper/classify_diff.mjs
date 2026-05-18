// Clasifica el diff entre un MD candidato (recién generado) y el MD actual del
// repo en una de tres decisiones:
//
//   "no_change"        → no hay diferencias materiales, no escribir nada al repo
//   "auto_merge"       → cambios solo en secciones no sensibles, mergear sin review
//   "requires_review"  → al menos una sección sensible cambió, abrir PR para revisión humana
//
// "Secciones sensibles" se define en sources.json.sensitive_sections.
//
// Uso CLI:
//   node classify_diff.mjs --candidate=state/mba.candidate.md --current=../posgrados/mba.md [--sources=sources.json]
//
// Output JSON a stdout.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---------- Parsing ----------

// Divide el MD en secciones por encabezado de nivel 2 (## ...).
// Devuelve un Map<sectionName, contentString> en orden de aparición.
// El prefacio antes de la primera ## queda bajo la key '__preface__'.
export function parseSections(md) {
  const lines = md.split('\n');
  const sections = new Map();
  let currentName = '__preface__';
  let buffer = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      sections.set(currentName, buffer.join('\n').trim());
      currentName = m[1].trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  sections.set(currentName, buffer.join('\n').trim());
  return sections;
}

// Normaliza un bloque para comparación: trim, colapsa whitespace, ignora
// la línea de "Última actualización del dato" y el cierre "Última revisión
// humana" que cambian en cada corrida.
export function normalizeForDiff(text) {
  return text
    .split('\n')
    .filter((l) => !/\*\*Última (?:revisión humana|actualización del dato)\*\*/i.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Diff classification ----------

export function diffSections(candidateSections, currentSections) {
  const allNames = new Set([...candidateSections.keys(), ...currentSections.keys()]);
  allNames.delete('__preface__'); // El preface (intro narrativa) la tratamos junto con __preface__ si cambia
  const changed = [];
  const added = [];
  const removed = [];
  for (const name of allNames) {
    const inCandidate = candidateSections.has(name);
    const inCurrent = currentSections.has(name);
    if (inCandidate && !inCurrent) {
      added.push(name);
    } else if (!inCandidate && inCurrent) {
      removed.push(name);
    } else {
      const candNorm = normalizeForDiff(candidateSections.get(name));
      const curNorm = normalizeForDiff(currentSections.get(name));
      if (candNorm !== curNorm) changed.push(name);
    }
  }
  // Preface: si cambió la intro, lo contamos como cambio en una "sección virtual"
  const prefCand = normalizeForDiff(candidateSections.get('__preface__') || '');
  const prefCur = normalizeForDiff(currentSections.get('__preface__') || '');
  if (prefCand !== prefCur) changed.push('__preface__');
  return { changed, added, removed };
}

export function classifyDiff(candidate, current, { sensitiveSections = [], previewLines = 8 } = {}) {
  if (!current) {
    return {
      decision: 'requires_review',
      reason: 'no_existing_md',
      changed_sections: [],
      sensitive_changes: [],
      non_sensitive_changes: [],
      added_sections: [],
      removed_sections: [],
      preview: candidate.split('\n').slice(0, previewLines).join('\n'),
    };
  }

  const candSections = parseSections(candidate);
  const curSections = parseSections(current);
  const { changed, added, removed } = diffSections(candSections, curSections);

  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    return {
      decision: 'no_change',
      reason: 'sections_match',
      changed_sections: [],
      sensitive_changes: [],
      non_sensitive_changes: [],
      added_sections: [],
      removed_sections: [],
    };
  }

  // Added o removed sections siempre son sensibles (cambio estructural).
  const structuralChange = added.length > 0 || removed.length > 0;
  const sensitiveSet = new Set(sensitiveSections);
  const sensitive = changed.filter((name) => sensitiveSet.has(name));
  const nonSensitive = changed.filter((name) => !sensitiveSet.has(name));

  const requiresReview = structuralChange || sensitive.length > 0;
  return {
    decision: requiresReview ? 'requires_review' : 'auto_merge',
    reason: requiresReview
      ? (structuralChange ? 'structural_change' : 'sensitive_section_changed')
      : 'only_non_sensitive_changes',
    changed_sections: changed,
    sensitive_changes: sensitive,
    non_sensitive_changes: nonSensitive,
    added_sections: added,
    removed_sections: removed,
  };
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      current: { type: 'string' },
      sources: { type: 'string', default: 'sources.json' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || !values.candidate) {
    console.log(`Sophia KB diff classifier

Uso:
  node classify_diff.mjs --candidate=state/mba.candidate.md --current=../posgrados/mba.md [--sources=sources.json]

Output JSON con decision: no_change | auto_merge | requires_review.
`);
    process.exit(values.help ? 0 : 2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candPath = resolve(here, values.candidate);
  if (!existsSync(candPath)) {
    console.error(`Candidate no existe: ${candPath}`);
    process.exit(2);
  }
  const candidate = await readFile(candPath, 'utf8');

  let current = '';
  if (values.current) {
    const curPath = resolve(here, values.current);
    if (existsSync(curPath)) current = await readFile(curPath, 'utf8');
  }

  const sourcesPath = resolve(here, values.sources);
  const sourcesData = existsSync(sourcesPath) ? JSON.parse(await readFile(sourcesPath, 'utf8')) : {};
  const sensitiveSections = sourcesData.sensitive_sections || [];

  const result = classifyDiff(candidate, current, { sensitiveSections });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
