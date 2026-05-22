import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 5 Sectors Taxonomy
const SECTORS = {
  POSGRADOS_GRADUADOS: 'posgrados_graduados',
  GRADO: 'grado',
  POSGRADOS_CURSOS_SIN_TITULO: 'posgrados_cursos_sin_titulo',
  DOCENTES: 'docentes',
  TRAMITES_BEDELIA: 'tramites_bedelia',
};

const SECTOR_NAMES = {
  [SECTORS.POSGRADOS_GRADUADOS]: 'Posgrados (Graduados)',
  [SECTORS.GRADO]: 'Estudiantes de Grado',
  [SECTORS.POSGRADOS_CURSOS_SIN_TITULO]: 'Posgrados y Cursos sin título de grado',
  [SECTORS.DOCENTES]: 'Docentes',
  [SECTORS.TRAMITES_BEDELIA]: 'Trámites (No docentes y Bedelía)',
};

export function classifyItem(item) {
  const path = item.path || '';
  const title = (item.title || '').toLowerCase();
  const category = (item.category || '').toLowerCase();
  const pathLower = path.toLowerCase();

  // 1. DOCENTES (Prioridad alta para palabras clave de personal docente)
  if (
    pathLower.includes('docente') ||
    pathLower.includes('profesor') ||
    pathLower.includes('jurado') ||
    title.includes('docente') ||
    title.includes('profesor') ||
    title.includes('enseñanza') ||
    title.includes('ensenanza') ||
    pathLower.includes('regimen-de-ensenanza') ||
    pathLower.includes('normas-y-procedimientos-de-ensenanza')
  ) {
    return SECTORS.DOCENTES;
  }

  // 2. POSGRADOS (Graduados) - Directorios de Posgrado y Diplomaturas Superiores (título de grado)
  if (
    pathLower.startsWith('posgrados/') ||
    pathLower.startsWith('posgrado-general/') ||
    pathLower.startsWith('compartidos/') ||
    category.includes('doctorado') ||
    category.includes('maestría') ||
    category.includes('maestria') ||
    category.includes('especialización') ||
    category.includes('especializacion') ||
    category.includes('diplomatura universitaria superior') ||
    title.includes('diplomatura universitaria superior') ||
    pathLower.includes('04-posgrado')
  ) {
    return SECTORS.POSGRADOS_GRADUADOS;
  }

  // 3. POSGRADOS Y CURSOS SIN TÍTULO DE GRADO (Diplomaturas de pregrado y cursos libres)
  if (
    pathLower.startsWith('diplomaturas/') ||
    pathLower.startsWith('cursos/') ||
    category.includes('diplomatura') ||
    category.includes('formación profesional') ||
    category.includes('formacion profesional') ||
    pathLower.includes('diplomatura') ||
    title.includes('diplomatura')
  ) {
    // Como las diplomaturas superiores se filtraron arriba, aquí solo entran las de pregrado y cursos
    return SECTORS.POSGRADOS_CURSOS_SIN_TITULO;
  }

  // 4. ESTUDIANTES DE GRADO
  if (
    pathLower.startsWith('estudiantes/') ||
    pathLower.includes('02-grado') ||
    category === 'estudiantes' ||
    pathLower.includes('ingreso-2026')
  ) {
    return SECTORS.GRADO;
  }

  // 5. TRÁMITES (No docentes y Bedelía) - Fallback para resoluciones generales o aulas
  if (
    pathLower.includes('aulas-virtuales') ||
    pathLower.includes('bedelia') ||
    pathLower.includes('06-reglamentos') ||
    title.includes('resolución') ||
    title.includes('resolucion') ||
    title.includes('norma') ||
    title.includes('procedimiento')
  ) {
    return SECTORS.TRAMITES_BEDELIA;
  }

  // Fallback / Default
  return SECTORS.TRAMITES_BEDELIA;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const kbRoot = resolve(here, '../..');
  const indexPath = join(kbRoot, 'indice.json');
  const outputPath = join(kbRoot, 'routing_metadata.json');

  console.log(`Leyendo índice desde ${indexPath}...`);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));

  const mappings = {};
  const stats = {
    [SECTORS.POSGRADOS_GRADUADOS]: 0,
    [SECTORS.GRADO]: 0,
    [SECTORS.POSGRADOS_CURSOS_SIN_TITULO]: 0,
    [SECTORS.DOCENTES]: 0,
    [SECTORS.TRAMITES_BEDELIA]: 0,
  };

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
