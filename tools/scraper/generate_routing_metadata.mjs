import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Taxonomía canónica: fuente de verdad única para web + Drive.
const TAXONOMY = JSON.parse(
  await readFile(join(here, 'taxonomy.json'), 'utf8'),
);

export const SECTOR_NAMES = Object.fromEntries(
  Object.entries(TAXONOMY.sectors).map(([id, s]) => [id, s.displayName]),
);

// Evalúa las reglas de match de un sector contra un item del índice.
// Reproduce la semántica del clasificador original: toLowerCase sin normalizar
// acentos; pathPrefix usa startsWith; el resto usa includes (o igualdad exacta
// para categoryEquals).
function matchesSector(rules, { pathLower, title, category }) {
  if (!rules) return false;
  if (rules.pathPrefix?.some(p => pathLower.startsWith(p.toLowerCase()))) return true;
  if (rules.pathIncludes?.some(p => pathLower.includes(p.toLowerCase()))) return true;
  if (rules.titleIncludes?.some(t => title.includes(t.toLowerCase()))) return true;
  if (rules.categoryIncludes?.some(c => category.includes(c.toLowerCase()))) return true;
  if (rules.categoryEquals?.some(c => category === c.toLowerCase())) return true;
  return false;
}

// Normaliza un nombre de carpeta de Drive: sin acentos, minúsculas, sin espacios
// al borde. NO saca el prefijo numérico (eso lo hace stripNumPrefix aparte).
function normalizeFolderName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Saca un prefijo ordinal tipo "01-", "03_", "12 - " del nombre de carpeta.
function stripNumPrefix(value) {
  return value.replace(/^\d+\s*[-_]\s*/, '');
}

// Resuelve el sector a partir de la carpeta TOP-LEVEL de un path de Drive,
// matcheando contra driveFolderAliases de la taxonomía. Match EXACTO (tras
// normalizar y quitar prefijo numérico) para evitar el ruteo frágil por
// substring. Devuelve el sectorId o null si ninguna carpeta matchea.
export function resolveSectorFromDrivePath(drivePath) {
  const segments = String(drivePath ?? '').split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const norm = normalizeFolderName(segments[0]);
  const candidates = new Set([norm, stripNumPrefix(norm)]);

  const order = TAXONOMY.matchOrder?.length
    ? TAXONOMY.matchOrder
    : Object.keys(TAXONOMY.sectors);

  for (const sectorId of order) {
    const aliases = TAXONOMY.sectors[sectorId]?.driveFolderAliases || [];
    for (const alias of aliases) {
      const na = normalizeFolderName(alias);
      if (candidates.has(na) || candidates.has(stripNumPrefix(na))) {
        return sectorId;
      }
    }
  }

  return null;
}

export function classifyItem(item) {
  // Sector explícito y autoritativo (p. ej. resuelto desde la carpeta de Drive)
  // gana sobre las reglas heurísticas de path/title/category.
  if (item.sector && TAXONOMY.sectors[item.sector]) return item.sector;

  const path = item.path || '';
  const ctx = {
    pathLower: path.toLowerCase(),
    title: (item.title || '').toLowerCase(),
    category: (item.category || '').toLowerCase(),
  };

  for (const sectorId of TAXONOMY.matchOrder) {
    const sector = TAXONOMY.sectors[sectorId];
    if (matchesSector(sector?.match, ctx)) return sectorId;
  }

  return TAXONOMY.fallbackSector;
}

async function main() {
  const kbRoot = resolve(here, '../..');
  const indexPath = join(kbRoot, 'indice.json');
  const outputPath = join(kbRoot, 'routing_metadata.json');

  console.log(`Leyendo índice desde ${indexPath}...`);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));

  const mappings = {};
  const stats = Object.fromEntries(
    Object.keys(TAXONOMY.sectors).map(id => [id, 0]),
  );

  for (const item of index.items) {
    const sector = classifyItem(item);
    mappings[item.path] = {
      sector,
      displayName: SECTOR_NAMES[sector],
      title: item.title,
      category: item.category,
    };
    stats[sector]++;
  }

  const outputData = {
    version: 1,
    lastUpdated: new Date().toISOString().split('T')[0],
    description: 'Metadatos de ruteo estático para derivar consultas de Sophia según sector de contenido.',
    stats,
    mappings,
  };

  console.log('\n--- Resumen de Clasificación ---');
  for (const [sector, count] of Object.entries(stats)) {
    console.log(`${SECTOR_NAMES[sector]}: ${count} archivos`);
  }

  console.log(`\nEscribiendo metadatos de ruteo en ${outputPath}...`);
  await writeFile(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
  console.log('¡Completado con éxito!');
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
