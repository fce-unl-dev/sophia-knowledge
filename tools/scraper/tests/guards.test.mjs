// Guardas compartidas de los pipelines del KB.
//
// Los casos de checkRemovalRatio están calibrados contra tres episodios reales
// del repo, y son la razón por la que el umbral es 30% y no "más bajas que
// activos". Si alguien mueve el umbral, estos tests dicen a qué caso real le
// está cambiando el veredicto.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  usefulTextLength,
  checkRawFloor,
  checkRawRegression,
  checkRemovalRatio,
  checkContentRegression,
  DEFAULT_MIN_RAW_CHARS,
  DEFAULT_MIN_DOC_CHARS,
} from '../guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('usefulTextLength', () => {
  test('no cuenta líneas en blanco ni espacios repetidos', () => {
    assert.equal(usefulTextLength('  \n\n\t\n   '), 0);
    assert.equal(usefulTextLength('uno   dos\n\n\ntres'), 'uno dos\ntres'.length);
  });
  test('texto vacío o nulo cuenta cero', () => {
    assert.equal(usefulTextLength(''), 0);
    assert.equal(usefulTextLength(undefined), 0);
  });
});

describe('checkRawFloor', () => {
  test('deja pasar un scrape por encima del piso', () => {
    assert.equal(checkRawFloor('a'.repeat(DEFAULT_MIN_RAW_CHARS)), null);
  });
  test('corta un scrape por debajo del piso y dice cuánto trajo', () => {
    const hit = checkRawFloor('a'.repeat(50));
    assert.equal(hit.status, 'insufficient-raw');
    assert.equal(hit.raw_length, 50);
    assert.equal(hit.min_raw_chars, DEFAULT_MIN_RAW_CHARS);
    assert.match(hit.reason, /50 caracteres útiles/);
  });
  test('el piso de documentos sueltos es más bajo que el de fichas web', () => {
    assert.ok(DEFAULT_MIN_DOC_CHARS < DEFAULT_MIN_RAW_CHARS);
    assert.equal(checkRawFloor('a'.repeat(300), { minRawChars: DEFAULT_MIN_DOC_CHARS }), null);
    assert.equal(checkRawFloor('a'.repeat(300)).status, 'insufficient-raw');
  });
});

describe('checkRawRegression', () => {
  test('sin tamaño previo no hay con qué comparar', () => {
    assert.equal(checkRawRegression(100, undefined), null);
    assert.equal(checkRawRegression(100, 0), null);
  });
  test('una caída dentro del margen pasa', () => {
    assert.equal(checkRawRegression(1500, 1800), null);
  });
  test('una caída por debajo del 40% corta e informa los dos tamaños', () => {
    const hit = checkRawRegression(1500, 10000);
    assert.equal(hit.status, 'raw-regression');
    assert.equal(hit.raw_length, 1500);
    assert.equal(hit.previous_raw_length, 10000);
    assert.match(hit.reason, /15% del tamaño previo/);
  });
});

describe('checkRemovalRatio — casos reales del repo', () => {
  test('Drive 24/08: 13 bajas de 31 documentos, sin altas → corta', () => {
    const hit = checkRemovalRatio({ inventory: 31, removals: 13, additions: 0 });
    assert.equal(hit.status, 'removal-anomaly');
    assert.equal(hit.net_removals, 13);
    assert.equal(hit.removal_ratio, 0.4194);
    assert.match(hit.reason, /sin ninguna alta que las compense/);
  });

  test('cursos de formación: 3 bajas de 16 fichas, sin altas → pasa', () => {
    assert.equal(checkRemovalRatio({ inventory: 16, removals: 3, additions: 0 }), null);
  });

  test('cursos de posgrado: 2 bajas de 8 fichas con 4 altas → pasa', () => {
    assert.equal(checkRemovalRatio({ inventory: 8, removals: 2, additions: 4 }), null);
  });
});

describe('checkRemovalRatio — forma de la regla', () => {
  test('las altas compensan bajas netas', () => {
    assert.equal(checkRemovalRatio({ inventory: 10, removals: 6, additions: 6 }), null);
    assert.equal(checkRemovalRatio({ inventory: 10, removals: 6, additions: 2 }).status, 'removal-anomaly');
  });
  test('una sola baja no dispara por más que sea un inventario chico', () => {
    assert.equal(checkRemovalRatio({ inventory: 3, removals: 1, additions: 0 }), null);
  });
  test('que desaparezca el inventario entero siempre dispara', () => {
    assert.equal(checkRemovalRatio({ inventory: 1, removals: 1, additions: 0 }).status, 'removal-anomaly');
    assert.match(checkRemovalRatio({ inventory: 4, removals: 4, additions: 0 }).reason, /inventario entero/);
  });
  test('sin bajas o sin inventario no hay nada que medir', () => {
    assert.equal(checkRemovalRatio({ inventory: 10, removals: 0 }), null);
    assert.equal(checkRemovalRatio({ inventory: 0, removals: 5 }), null);
  });
  test('el umbral es configurable por pipeline', () => {
    assert.equal(checkRemovalRatio({ inventory: 16, removals: 3, additions: 0, maxRemovalRatio: 0.1 }).status, 'removal-anomaly');
  });
});

describe('checkContentRegression', () => {
  test('sin ficha previa no hay con qué comparar', () => {
    assert.equal(checkContentRegression('texto nuevo', ''), null);
  });
  test('un candidato de tamaño parecido pasa', () => {
    assert.equal(checkContentRegression('a'.repeat(900), 'a'.repeat(1000)), null);
  });
  test('un candidato que encoge la ficha a un esqueleto corta', () => {
    const hit = checkContentRegression('a'.repeat(100), 'a'.repeat(1000), { label: 'cursos/x.md' });
    assert.equal(hit.status, 'content-regression');
    assert.equal(hit.candidate_length, 100);
    assert.equal(hit.previous_length, 1000);
    assert.match(hit.reason, /cursos\/x\.md/);
  });
});

describe('cobertura de las guardas en los pipelines', () => {
  // Los scrapers que borran contenido del KB o que le pasan texto scrapeado a un
  // modelo tienen que estar conectados a guards.mjs. Si alguien agrega uno
  // nuevo, o desconecta uno existente, este test lo canta.
  const OBLIGATORIOS = [
    'generate_md.mjs',
    'scrape_drive.mjs',
    'propose_courses_update.mjs',
    'propose_posgrado_courses_update.mjs',
    'propose_sections_update.mjs',
  ];

  test('todos los pipelines que borran o generan importan guards.mjs', async () => {
    const sinGuardas = [];
    for (const file of OBLIGATORIOS) {
      const src = await readFile(join(here, '..', file), 'utf8');
      if (!/from '\.\/guards\.mjs'/.test(src)) sinGuardas.push(file);
    }
    assert.deepEqual(sinGuardas, [], `Estos pipelines no están conectados a guards.mjs: ${sinGuardas.join(', ')}`);
  });

  test('ningún pipeline se quedó con una copia propia de usefulTextLength', async () => {
    const files = (await readdir(join(here, '..'))).filter((f) => f.endsWith('.mjs') && f !== 'guards.mjs');
    const duplicados = [];
    for (const file of files) {
      const src = await readFile(join(here, '..', file), 'utf8');
      if (/export function usefulTextLength/.test(src)) duplicados.push(file);
    }
    assert.deepEqual(duplicados, [], `Definen su propia usefulTextLength en vez de usar la compartida: ${duplicados.join(', ')}`);
  });
});
