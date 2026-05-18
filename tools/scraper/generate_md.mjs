// Generador de MDs del KB de Sophia con Gemini 2.5 Flash.
//
// Lee state/{slug}.raw.txt (output del scraper) + template canónico del repo +
// MD actual (si existe) y produce state/{slug}.candidate.md respetando la
// estructura del template.
//
// Uso CLI:
//   node generate_md.mjs --slug=mba [--out=state/] [--source=sources.json]
//   node generate_md.mjs --all      [--out=state/]
//
// Requiere env GEMINI_API_KEY (Google AI Studio).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const REQUEST_TIMEOUT_MS = 120_000;

// ---------- System prompt ----------

export const SYSTEM_INSTRUCTION = `Sos el redactor del Knowledge Base de Sophia, asistente virtual oficial de la Facultad de Ciencias Económicas (FCE) de la UNL. Tu único trabajo es generar fichas Markdown de propuestas académicas siguiendo EXACTAMENTE la plantilla canónica de la FCE.

REGLAS DURAS (no negociables):

R1. Estructura: respetá el orden y los títulos exactos de las secciones del template. NUNCA agregues secciones nuevas ni cambies los nombres. Si una sección no tiene datos en el material provisto, manténela presente y completá con "No publicado en fuentes oficiales — consultar con {email del programa}".

R2. Extracción honesta: usá EXCLUSIVAMENTE el contenido que aparece en el SCRAPE provisto. NO uses tu conocimiento previo de la FCE-UNL, ni inventes nombres, fechas, montos, emails ni cargos. Si un dato concreto no aparece en el SCRAPE, decilo explícitamente con "No publicado".

R3. Ignorá ruido: extraé solo lo que aplique al template (información estable del programa académico). Ignorá noticias y eventos de coyuntura, anuncios puntuales, banners promocionales, menús de navegación, breadcrumbs y resultados de búsqueda. Si el scrape repite el menú lateral muchas veces, ignorá esa repetición.

R4. Preservá literalidad de URLs, emails y teléfonos: copialos TAL CUAL aparecen en el scrape, sin modificar dominios, mayúsculas, parámetros ni protocolos.

R5. Tono curado y neutro: cero formalismos institucionales vacíos. PROHIBIDO usar "Muchas gracias por tu interés", "Quedamos a disposición", "Esperamos contar con su participación", "Es un placer informarle" o similares. Redactá como ficha técnica.

R6. Continuidad con el MD actual: si te pasan un MD ACTUAL como referencia, conservá datos que ya estén verificados ahí y que NO aparezcan en el SCRAPE (especialmente fechas históricas, acreditaciones CONEAU, nombres de directores). Pero si el SCRAPE contradice al MD ACTUAL en un dato verificable (fecha de cohorte, modalidad, plan de estudios), priorizá el SCRAPE y marcá la sección como cambiada.

R7. Sección "Fuentes consultadas": al final, listá las URLs del SCRAPE que efectivamente aportaron contenido para esta ficha (no todas las del scrape — solo las que usaste).

R8. Formato de salida: devolvé ÚNICAMENTE el contenido del MD final, listo para escribir a archivo. SIN preámbulo, SIN comentarios, SIN bloques de código markdown envolventes (no \`\`\`markdown ... \`\`\`). Empezá directamente con "# {Nombre oficial del programa}".

R9. Cierre: agregá al final una línea exactamente así:
"**Última revisión humana**: PENDIENTE — draft autogenerado el {YYYY-MM-DD} por pipeline de scraping."
Donde {YYYY-MM-DD} es la fecha actual provista en el contexto.`;

// ---------- Prompt building ----------

export function buildUserPrompt({ template, currentMd, rawText, sourceUrl, today, sourceTitle }) {
  const parts = [
    `Fecha actual: ${today}`,
    `URL canónica del programa: ${sourceUrl}`,
  ];
  if (sourceTitle) parts.push(`Título del programa: ${sourceTitle}`);
  parts.push(
    '',
    '=========================',
    'PLANTILLA CANÓNICA (estructura obligatoria)',
    '=========================',
    template,
    '',
    '=========================',
    'MD ACTUAL (referencia para datos verificados manualmente — preservar si no contradicen el scrape)',
    '=========================',
    currentMd || '(no existe MD previo en el KB para este programa — generá desde cero usando solo el scrape)',
    '',
    '=========================',
    'SCRAPE WEB (única fuente de hechos para esta corrida)',
    '=========================',
    rawText,
    '',
    '=========================',
    'TAREA',
    '=========================',
    'Generá la ficha MD final aplicando todas las reglas duras del system prompt. Devolvé SOLO el MD, sin nada antes ni después.',
  );
  return parts.join('\n');
}

// ---------- Gemini call ----------

export async function callGemini({ apiKey, systemInstruction, userPrompt, model = DEFAULT_MODEL, fetchImpl = fetch, temperature = 0.2, maxOutputTokens = 16384 } = {}) {
  if (!apiKey) throw new Error('callGemini: missing apiKey (set GEMINI_API_KEY)');

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'text/plain' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${GEMINI_URL(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errBody = await safeText(res);
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const json = await res.json();
  const text = extractText(json);
  if (!text) {
    throw new Error(`Gemini response sin texto: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return { text, raw: json };
}

function extractText(json) {
  const cand = json?.candidates?.[0];
  if (!cand) return '';
  const parts = cand?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

// ---------- Output cleanup ----------

// El LLM a veces envuelve la respuesta en ```markdown ... ``` aunque le digamos
// que no — defensivo.
export function stripMarkdownFence(text) {
  const t = text.trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : t;
}

// ---------- Orchestrator ----------

export async function generateForSource(source, { sourcesData, stateDir, kbRoot, apiKey, fetchImpl = fetch, today, model, write = true } = {}) {
  const rawPath = join(stateDir, `${source.slug}.raw.txt`);
  if (!existsSync(rawPath)) {
    return { slug: source.slug, status: 'no-raw', reason: `${rawPath} no existe — corré scrape.mjs antes` };
  }
  const rawText = await readFile(rawPath, 'utf8');

  const templatePath = join(kbRoot, 'template.md');
  const template = await readFile(templatePath, 'utf8');

  const currentMdPath = join(kbRoot, source.indice_path);
  const currentMd = existsSync(currentMdPath) ? await readFile(currentMdPath, 'utf8') : '';

  const sourceTitle = (sourcesData?.sources || []).find((s) => s.slug === source.slug)?.title;
  const userPrompt = buildUserPrompt({ template, currentMd, rawText, sourceUrl: source.url, today, sourceTitle });

  const { text, raw } = await callGemini({ apiKey, systemInstruction: SYSTEM_INSTRUCTION, userPrompt, model, fetchImpl });
  const candidate = stripMarkdownFence(text);

  const outPath = join(stateDir, `${source.slug}.candidate.md`);
  const metaPath = join(stateDir, `${source.slug}.gen.meta.json`);
  const usage = raw?.usageMetadata || {};
  const meta = {
    slug: source.slug,
    model: model || DEFAULT_MODEL,
    generated_at: new Date().toISOString(),
    prompt_tokens: usage.promptTokenCount ?? null,
    output_tokens: usage.candidatesTokenCount ?? null,
    total_tokens: usage.totalTokenCount ?? null,
    candidate_length: candidate.length,
    candidate_path: outPath,
  };

  if (write) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(outPath, candidate.endsWith('\n') ? candidate : candidate + '\n', 'utf8');
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }

  return { slug: source.slug, status: 'generated', ...meta };
}

// ---------- CLI ----------

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      all: { type: 'boolean', default: false },
      source: { type: 'string', default: 'sources.json' },
      out: { type: 'string', default: 'state' },
      'kb-root': { type: 'string', default: '..' }, // tools/scraper/.. = repo root
      model: { type: 'string', default: DEFAULT_MODEL },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || (!values.slug && !values.all)) {
    console.log(`Sophia KB generator

Uso:
  node generate_md.mjs --slug=<slug> [--out=state/] [--source=sources.json] [--kb-root=..] [--model=gemini-2.5-flash]
  node generate_md.mjs --all          [--out=state/] [--source=sources.json] [--kb-root=..] [--model=gemini-2.5-flash]

Env requerido: GEMINI_API_KEY
`);
    process.exit(values.help ? 0 : 1);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: falta env GEMINI_API_KEY');
    process.exit(2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = resolve(here, values.source);
  const stateDir = resolve(here, values.out);
  const kbRoot = resolve(here, values['kb-root']);

  const sourcesData = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const sources = sourcesData.sources || [];
  const targets = values.all ? sources : sources.filter((s) => s.slug === values.slug);

  if (targets.length === 0) {
    console.error(`No matching source for slug='${values.slug}'`);
    process.exit(2);
  }

  const today = todayIsoDate();
  const write = !values['no-write'];
  const report = [];
  for (const src of targets) {
    if (src.strategy === 'TBD') {
      process.stderr.write(`→ ${src.slug}  skipped (strategy=TBD)\n`);
      report.push({ slug: src.slug, status: 'skipped', reason: 'strategy=TBD' });
      continue;
    }
    process.stderr.write(`→ ${src.slug} (${values.model})\n`);
    try {
      const r = await generateForSource(src, { sourcesData, stateDir, kbRoot, apiKey, today, model: values.model, write });
      report.push(r);
      process.stderr.write(`  ${r.status}  tokens(in/out)=${r.prompt_tokens}/${r.output_tokens}  md_len=${r.candidate_length}\n`);
    } catch (err) {
      const r = { slug: src.slug, status: 'error', error: String(err.message || err) };
      report.push(r);
      process.stderr.write(`  ERROR: ${r.error}\n`);
    }
  }

  console.log(JSON.stringify({ ok: true, count: report.length, results: report }, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
