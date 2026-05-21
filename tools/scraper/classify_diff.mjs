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
import { callGemini, stripMarkdownFence } from './generate_md.mjs';

const DEFAULT_AUDIT_MODEL = 'gemini-2.5-pro';

export const CLASSIFICATION_SYSTEM_INSTRUCTION = `Sos el Auditor de Cambios del Knowledge Base de Sophia, el asistente virtual oficial de la Facultad de Ciencias Económicas (FCE) de la UNL. Tu tarea es analizar las diferencias (diff) entre el contenido actual de una ficha técnica de la base de conocimientos y el nuevo borrador (candidato) generado a partir de la última extracción web (scraping).

Tu objetivo principal es maximizar la automatización (permitiendo auto_merge) para cambios seguros, claros y consistentes, mientras filtras y derivás a revisión humana (requires_review) solo lo que sea realmente ambiguo, contradictorio, incompleto o sospechoso de error.

REGLAS DE DECISIÓN:

1. AUTO_MERGE (Aprobación Automática):
   - Actualizaciones de aranceles (tasas, precios, cuotas), siempre que los montos nuevos sean legibles y coherentes.
   - Actualizaciones de fechas (fechas de inicio de clases, inscripciones, cohortes futuras), siempre que no representen regresiones temporales (por ejemplo, cambiar del año actual a un año pasado).
   - Correcciones de errores ortográficos, gramaticales o de redacción.
   - Actualización de nombres de directores, coordinadores, correos de contacto o teléfonos oficiales.
   - Cambios de aulas, horarios de cursado o links a formularios/páginas web oficiales.
   - En general, cualquier cambio de datos que sea claro, lógico, libre de contradicciones internas y consistente con el resto del documento.

2. REQUIRES_REVIEW (Requiere Revisión Humana):
   - Contradicciones internas: Por ejemplo, que en una parte de la ficha diga que la modalidad es "Virtual" y en otra diga "Presencial", o que se mencionen requisitos contradictorios.
   - Regresiones temporales: Cambiar fechas de cohorte o inscripciones del futuro (ej. 2026) al pasado (ej. 2025), a menos que sea una corrección de un error claro.
   - Información sospechosa de error de scraping: Texto que parezca código, mensajes de error web ("404", "Acceso denegado", "Página no encontrada"), fragmentos de menús rotos o textos totalmente incoherentes.
   - Ambigüedades críticas: Datos extremadamente vagos, confusos o donde falte información esencial que antes sí estaba (ej. se borra por completo el correo de contacto sin proponer otro, o se elimina toda la sección de plan de estudios).
   - Cambios estructurales drásticos que eliminen grandes bloques de información verificada sin reemplazo.
   - Si el archivo es NUEVO (no existe versión anterior) pero está incompleto, contiene errores de scraping notables o carece de información crítica (ej. sin sección de contacto o sin plan de estudios).

FORMATO DE SALIDA:
Debes responder EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin bloques de código \`\`\`json). El JSON debe tener la siguiente estructura exacta:
{
  "decision": "auto_merge" | "requires_review",
  "reason": "Una línea explicando brevemente la decisión (ej. 'Actualización de arancel de cohorte 2026')",
  "detailed_analysis": "Explicación detallada en español de qué cambió y por qué se tomó esta decisión, detallando cualquier ambigüedad, duda o contradicción encontrada."
}
`;

export function buildClassificationPrompt({ currentMd, candidateMd, diffText }) {
  return `
=================================
MD ACTUAL (Versión en producción)
=================================
${currentMd || '(Archivo nuevo, no existe versión previa)'}

=================================
MD CANDIDATO (Borrador propuesto)
=================================
${candidateMd}

=================================
DIFERENCIAS DETECTADAS (Diff de secciones)
=================================
${diffText}

=================================
INSTRUCCIÓN
=================================
Analizá los cambios semánticamente y tomá la decisión de auditoría ("auto_merge" o "requires_review") de acuerdo con las reglas de decisión. Respondé únicamente con el objeto JSON solicitado.
`;
}

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

export async function classifyDiff(candidate, current, { sensitiveSections = [], previewLines = 8, apiKey = '', model = DEFAULT_AUDIT_MODEL, fetchImpl = fetch } = {}) {
  const candSections = parseSections(candidate);
  const curSections = current ? parseSections(current) : new Map();
  const { changed, added, removed } = diffSections(candSections, curSections);

  if (current && changed.length === 0 && added.length === 0 && removed.length === 0) {
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

  // Fallback a reglas tradicionales si no hay apiKey
  if (!apiKey) {
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

  // Lógica de clasificación con IA (Gemini 2.5 Pro)
  let diffText = '';
  if (!current) {
    diffText = 'ARCHIVO NUEVO: No existe versión anterior. Toda la información es nueva.\n';
  } else {
    for (const name of changed) {
      diffText += `### Sección Modificada: ${name}\n`;
      diffText += `--- ANTERIOR ---\n${curSections.get(name) || '(vacía)'}\n`;
      diffText += `--- PROPUESTA ---\n${candSections.get(name) || '(vacía)'}\n\n`;
    }
    for (const name of added) {
      diffText += `### Sección Agregada: ${name}\n`;
      diffText += `${candSections.get(name) || '(vacía)'}\n\n`;
    }
    for (const name of removed) {
      diffText += `### Sección Eliminada: ${name}\n`;
      diffText += `${curSections.get(name) || '(vacía)'}\n\n`;
    }
  }

  const userPrompt = buildClassificationPrompt({
    currentMd: current,
    candidateMd: candidate,
    diffText,
  });

  try {
    const response = await callGemini({
      apiKey,
      systemInstruction: CLASSIFICATION_SYSTEM_INSTRUCTION,
      userPrompt,
      model,
      fetchImpl,
      temperature: 0.1,
    });

    const parsed = JSON.parse(stripMarkdownFence(response.text));
    const decision = (parsed.decision === 'auto_merge' || parsed.decision === 'requires_review')
      ? parsed.decision
      : 'requires_review';

    const sensitiveSet = new Set(sensitiveSections);
    const sensitive = changed.filter((name) => sensitiveSet.has(name));
    const nonSensitive = changed.filter((name) => !sensitiveSet.has(name));

    return {
      decision,
      reason: parsed.reason || 'ai_decision',
      detailed_analysis: parsed.detailed_analysis || '',
      changed_sections: changed,
      sensitive_changes: sensitive,
      non_sensitive_changes: nonSensitive,
      added_sections: added,
      removed_sections: removed,
      preview: !current ? candidate.split('\n').slice(0, previewLines).join('\n') : undefined
    };
  } catch (err) {
    console.warn(`[classifyDiff] Fallback a reglas debido a error en Gemini:`, err.message || err);
    if (!current) {
      return {
        decision: 'requires_review',
        reason: 'no_existing_md_gemini_failed',
        changed_sections: [],
        sensitive_changes: [],
        non_sensitive_changes: [],
        added_sections: [],
        removed_sections: [],
        preview: candidate.split('\n').slice(0, previewLines).join('\n'),
      };
    }

    const structuralChange = added.length > 0 || removed.length > 0;
    const sensitiveSet = new Set(sensitiveSections);
    const sensitive = changed.filter((name) => sensitiveSet.has(name));
    const nonSensitive = changed.filter((name) => !sensitiveSet.has(name));
    const requiresReview = structuralChange || sensitive.length > 0;

    return {
      decision: requiresReview ? 'requires_review' : 'auto_merge',
      reason: `gemini_failed_fallback_${requiresReview ? 'requires_review' : 'auto_merge'}`,
      changed_sections: changed,
      sensitive_changes: sensitive,
      non_sensitive_changes: nonSensitive,
      added_sections: added,
      removed_sections: removed,
    };
  }
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      current: { type: 'string' },
      sources: { type: 'string', default: 'sources.json' },
      model: { type: 'string', default: DEFAULT_AUDIT_MODEL },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || !values.candidate) {
    console.log(`Sophia KB diff classifier

Uso:
  node classify_diff.mjs --candidate=state/mba.candidate.md --current=../posgrados/mba.md [--sources=sources.json] [--model=gemini-2.5-pro]

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

  const apiKey = process.env.GEMINI_API_KEY || '';
  const result = await classifyDiff(candidate, current, {
    sensitiveSections,
    apiKey,
    model: values.model
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
