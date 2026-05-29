// Convierte el resultado de scrapeFceWordpressSection (crawl de una rama
// WordPress completa) en candidatos de KB: UN MD por subpágina importante.
//
// Criterio (decidido con el usuario):
//   - "Subpágina importante" = texto real ≥ umbral (default 200 chars) tras
//     limpiar boilerplate. Genera su propio MD.
//   - Páginas flacas (bajo umbral), documentos (PDF/planillas link-only) y links
//     pendientes por truncación se listan como ENLACES en el MD landing de la
//     rama, no generan MD propio.
//   - Sector y carpeta destino se derivan de la taxonomía canónica (kbFolder).
//   - Señales de datos personales marcan requires_review (no se bloquea: toda la
//     info es pública; Sophia entrega el link y el usuario lo abre).
//
// Funciones puras y deterministas: NO hace red ni I/O. El orquestador
// (propose_sections_update.mjs) materializa, clasifica el diff y arma el PR.

import { normalizeSectionUrl } from './scrape.mjs';

export function slugify(value) {
  const s = String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'index';
}

// Longitud de texto "real" tras colapsar espacios.
export function cleanTextLength(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().length;
}

// Heurística mínima de datos personales sobre el texto ya extraído.
export function detectPossiblePersonalData(text) {
  const n = String(text ?? '').replace(/\s+/g, ' ').toLocaleLowerCase('es-AR');
  if (/nombre\s+y\s+apellido/.test(n)) return true;
  if (/\b(dni|documento)\b/.test(n) && /(listado|lista|nómina|nomina|alumnos|estudiantes|inscriptos)/.test(n)) return true;
  return false;
}

// Deriva el documento KB (slug global + indice_path dentro del kbFolder del
// sector) a partir de la URL de la subpágina. Descarta el segmento de ruido
// "categorias" del theme WordPress. La raíz de la rama mapea a
// {kbFolder}/{sectionId}.md.
export function deriveSectionDoc(url, { sectionId, sector, prefix }) {
  const kbFolder = sector.kbFolder;
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url || ''); }
  path = path.replace(/\/+$/, '');

  const pfx = (prefix || sector.webPathPrefixes?.[0] || `/${sectionId}`).replace(/\/+$/, '');
  let rest = path.toLowerCase().startsWith(pfx.toLowerCase()) ? path.slice(pfx.length) : path;
  rest = rest.replace(/^\/+/, '');

  const segments = rest.split('/').filter(Boolean).filter((s) => s.toLowerCase() !== 'categorias');
  const slugBase = segments.length === 0 ? sectionId : slugify(segments.join('-'));

  return {
    slug: `${sectionId}-${slugBase}`,
    indice_path: `${kbFolder}/${slugBase}.md`,
  };
}

// Detecta páginas de ARCHIVE de categoría del theme WordPress: URL con el
// segmento `categorias` (ej. /academica/categorias/X/). Son listados
// autogenerados de posts (body.class "archive category"), no contenido
// institucional propio. No deben generar MD: el post real se ingiere por su URL
// canónica (/academica/X/) y los documentos quedan en documentLinks del crawl.
export function isCategoryArchiveUrl(url, { prefix, sectionId, sector } = {}) {
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url || ''); }
  path = path.replace(/\/+$/, '');
  const pfx = (prefix || sector?.webPathPrefixes?.[0] || `/${sectionId}`).replace(/\/+$/, '');
  let rest = path.toLowerCase().startsWith(pfx.toLowerCase()) ? path.slice(pfx.length) : path;
  rest = rest.replace(/^\/+/, '');
  return rest.split('/').filter(Boolean).some((s) => s.toLowerCase() === 'categorias');
}

function appendTextAsBullets(lines, text) {
  const paragraphs = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    lines.push('- No se pudo extraer texto suficiente de la fuente.');
    return;
  }
  for (const p of paragraphs) {
    if (/^[-*]\s+/.test(p)) lines.push(p);
    else lines.push(`- ${p}`);
  }
}

// Apéndice de enlaces que NO se ingieren como MD propio: páginas flacas,
// documentos (link-only) y links pendientes por truncación.
function appendLinksAppendix(lines, { lowContent = [], documentLinks = [], pendingLinks = [], errored = [], truncated = false }) {
  const hasAny = lowContent.length || documentLinks.length || pendingLinks.length || errored.length;
  if (!hasAny) return;

  lines.push('## Enlaces relacionados (no ingeridos)');
  lines.push('');
  lines.push('Sophia debe entregar estos enlaces para que el usuario los abra; no se incorporó su contenido al documento.');
  lines.push('');

  if (documentLinks.length) {
    lines.push('- **Documentos (PDF / planillas / ofimática)** — link-only, pueden contener datos personales:');
    for (const u of documentLinks) lines.push(`  - ${u}`);
  }
  if (lowContent.length) {
    lines.push('- **Subpáginas sin contenido textual suficiente** (revisar si conviene incluirlas):');
    for (const p of lowContent) lines.push(`  - ${p.title || '(sin título)'}: ${p.url}`);
  }
  if (errored.length) {
    lines.push('- **Subpáginas que no se pudieron descargar** durante la revisión automática:');
    for (const p of errored) lines.push(`  - ${p.url} (${p.error})`);
  }
  if (truncated && pendingLinks.length) {
    lines.push('- ⚠️ **Crawl truncado**: se alcanzó el tope de páginas o profundidad. Estas URLs quedaron sin bajar y deben revisarse (ampliar maxPages/maxDepth si hay contenido útil):');
    for (const u of pendingLinks) lines.push(`  - ${u}`);
  }
  lines.push('');
}

// MD determinístico de una subpágina importante. El root de la rama lleva,
// además, el apéndice de enlaces no ingeridos.
export function buildSectionCandidateMarkdown({ page, sector, today, reviewReasons = [], appendix = null }) {
  const lines = [];
  lines.push(`# ${page.title || sector.displayName}`);
  lines.push('');
  lines.push('## Para qué sirve');
  lines.push('');
  lines.push(`- Documento del sector **${sector.displayName}** generado automáticamente desde la web institucional FCE-UNL.`);
  lines.push('- Es un candidato automático: debe pasar por revisión humana antes de mergearse a `indice.json`.');
  lines.push('');

  lines.push('## Información publicada');
  lines.push('');
  appendTextAsBullets(lines, page.text);
  lines.push('');

  if (appendix) appendLinksAppendix(lines, appendix);

  lines.push('## Advertencias para Sophia');
  lines.push('');
  if (reviewReasons.length) {
    for (const r of reviewReasons) lines.push(`- Requiere revisión humana: ${r}.`);
  } else {
    lines.push('- No se detectaron señales automáticas de datos personales; la revisión humana sigue siendo obligatoria.');
  }
  lines.push('- No responder con datos personalizados ni detrás de login; derivar al sistema o enlace oficial correspondiente.');
  lines.push('');

  lines.push('## Fuentes consultadas');
  lines.push('');
  lines.push(`- ${page.title || sector.displayName}: ${page.url}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Última revisión automática**: ${today} (candidato generado por el scraper de secciones WordPress)`);
  lines.push('**Revisión humana**: pendiente');
  lines.push('');
  return lines.join('\n');
}

// MD landing mínimo cuando la raíz de la rama no tuvo contenido propio pero hay
// enlaces que conviene preservar.
export function buildSectionLandingMarkdown({ sector, today, lowContent = [], documentLinks = [], pendingLinks = [], errored = [], truncated = false }) {
  const lines = [];
  lines.push(`# ${sector.displayName}`);
  lines.push('');
  lines.push('## Para qué sirve');
  lines.push('');
  lines.push(`- Índice de enlaces del sector **${sector.displayName}** (FCE-UNL). La página principal no tenía contenido textual propio suficiente.`);
  lines.push('- Candidato automático: requiere revisión humana antes de mergearse.');
  lines.push('');
  appendLinksAppendix(lines, { lowContent, documentLinks, pendingLinks, errored, truncated });
  lines.push('## Advertencias para Sophia');
  lines.push('');
  lines.push('- Entregar los enlaces de arriba para que el usuario los abra; no se ingirió su contenido.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Última revisión automática**: ${today} (landing de sección)`);
  lines.push('**Revisión humana**: pendiente');
  lines.push('');
  return lines.join('\n');
}

// Punto de entrada: dado el resultado del crawl de una rama, produce los
// candidatos (1 MD por subpágina importante) + el resumen de truncación/links.
export function buildSectionCandidates(sectionResult, { sectionId, taxonomy, threshold = 200, today = todayIso() } = {}) {
  const sector = taxonomy?.sectors?.[sectionId];
  if (!sector) throw new Error(`sector desconocido en taxonomy: ${sectionId}`);

  const prefix = (sector.webPathPrefixes?.[0] || `/${sectionId}`).replace(/\/+$/, '');
  const pages = sectionResult.pages || [];
  const rootNorm = pages.length ? normalizeSectionUrl(pages[0].url) : null;

  const important = [];
  const lowContent = [];
  const errored = [];
  const categoryArchives = [];
  for (const p of pages) {
    if (p.error) errored.push(p);
    else if (isCategoryArchiveUrl(p.url, { prefix, sectionId, sector })) categoryArchives.push(p);
    else if (cleanTextLength(p.text) >= threshold) important.push(p);
    else lowContent.push(p);
  }

  const documentLinks = sectionResult.documentLinks || [];
  const pendingLinks = sectionResult.pendingLinks || [];
  const truncated = !!sectionResult.truncated;

  const candidates = [];
  const seenPaths = new Set();
  const pathCollisions = [];

  for (const p of important) {
    const { slug, indice_path } = deriveSectionDoc(p.url, { sectionId, sector, prefix });
    const isRoot = normalizeSectionUrl(p.url) === rootNorm;
    const reviewReasons = [];
    if (detectPossiblePersonalData(p.text)) reviewReasons.push('posibles datos personales/listados nominales');
    if (seenPaths.has(indice_path)) {
      reviewReasons.push(`colisión de ruta: ${indice_path} ya fue derivado de otra subpágina`);
      pathCollisions.push({ indice_path, url: p.url });
    }
    seenPaths.add(indice_path);

    const markdown = buildSectionCandidateMarkdown({
      page: p, sector, today, reviewReasons,
      appendix: isRoot ? { lowContent, documentLinks, pendingLinks, errored, truncated } : null,
    });

    candidates.push({
      slug, indice_path, title: p.title, sector: sectionId, url: p.url,
      is_root: isRoot, requires_review: reviewReasons.length > 0, review_reasons: reviewReasons, markdown,
    });
  }

  // Si el root no generó candidato propio pero hay enlaces que preservar, landing.
  const hasRoot = candidates.some((c) => c.is_root);
  const hasLinkMaterial = lowContent.length || documentLinks.length || (truncated && pendingLinks.length) || errored.length;
  if (!hasRoot && hasLinkMaterial) {
    const landingUrl = rootNorm || prefix;
    const { slug, indice_path } = deriveSectionDoc(landingUrl, { sectionId, sector, prefix });
    const markdown = buildSectionLandingMarkdown({ sector, today, lowContent, documentLinks, pendingLinks, errored, truncated });
    candidates.push({
      slug, indice_path, title: sector.displayName, sector: sectionId, url: landingUrl,
      is_root: true, requires_review: false, review_reasons: [], markdown,
    });
  }

  return {
    section: sectionId,
    candidates,
    truncated,
    pending_links: pendingLinks,
    document_links: documentLinks,
    important_count: important.length,
    low_content_count: lowContent.length,
    errored_count: errored.length,
    category_archive_count: categoryArchives.length,
    path_collisions: pathCollisions,
  };
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
