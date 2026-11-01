import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyItem,
  resolveSectorFromDrivePath,
  parseSectorResponse,
} from '../generate_routing_metadata.mjs';

describe('resolveSectorFromDrivePath', () => {
  test('carpeta con prefijo numérico matchea alias (01-docentes → docentes)', () => {
    assert.equal(resolveSectorFromDrivePath('01-docentes/regimen.docx'), 'docentes');
  });

  test('alias sin prefijo numérico matchea (academica → academica)', () => {
    assert.equal(resolveSectorFromDrivePath('academica/plan.pdf'), 'academica');
  });

  test('alias bare matchea aunque la carpeta no tenga prefijo (investigacion → ciencia)', () => {
    assert.equal(resolveSectorFromDrivePath('investigacion/proyecto.pdf'), 'ciencia');
  });

  test('case-insensitive y sin acentos (Relaciones-Internacionales → internacionales)', () => {
    assert.equal(
      resolveSectorFromDrivePath('Relaciones-Internacionales/becas.pdf'),
      'internacionales',
    );
  });

  test('carpeta desconocida no matchea ningún alias → null', () => {
    assert.equal(resolveSectorFromDrivePath('Becas al exterior/foo.pdf'), null);
  });

  test('match exacto, no por substring (evita ruteo frágil)', () => {
    // "academicas-varias" NO debe matchear el alias "academica"
    assert.equal(resolveSectorFromDrivePath('academicas-varias/x.pdf'), null);
  });

  test('path vacío o sin segmentos → null', () => {
    assert.equal(resolveSectorFromDrivePath(''), null);
    assert.equal(resolveSectorFromDrivePath('/'), null);
  });

  test('solo mira la carpeta top-level, no subcarpetas', () => {
    // top-level "docentes" gana aunque haya subcarpeta con otro alias
    assert.equal(resolveSectorFromDrivePath('01-docentes/internacionales/x.pdf'), 'docentes');
  });

  test('guion bajo matchea alias con guion (07_AULAS_VIRTUALES → academica)', () => {
    assert.equal(resolveSectorFromDrivePath('07_AULAS_VIRTUALES/manual.pdf'), 'academica');
  });

  test('separadores mixtos y prefijo numérico (08_CALENDARIOS_Y_CRONOGRAMAS → academica)', () => {
    assert.equal(
      resolveSectorFromDrivePath('08_CALENDARIOS_Y_CRONOGRAMAS/2026.pdf'),
      'academica',
    );
  });

  test('ingreso resuelve a grado (01_INGRESO → grado)', () => {
    assert.equal(resolveSectorFromDrivePath('01_INGRESO/instructivo.pdf'), 'grado');
  });

  test('pregrado resuelve a posgrados_cursos_sin_titulo (03_PREGRADO → ...)', () => {
    assert.equal(
      resolveSectorFromDrivePath('03_PREGRADO/tecnicatura.pdf'),
      'posgrados_cursos_sin_titulo',
    );
  });
});

describe('classifyItem honra item.sector explícito', () => {
  test('usa item.sector cuando es un sector válido de la taxonomía', () => {
    const item = {
      path: 'complementos/cualquier-cosa.md',
      title: 'Algo',
      category: 'Complementario',
      sector: 'docentes',
    };
    assert.equal(classifyItem(item), 'docentes');
  });

  test('ignora item.sector inválido y cae a las reglas por path', () => {
    const item = {
      path: 'academica/plan.md',
      title: 'Plan',
      category: '',
      sector: 'sector-inexistente',
    };
    assert.equal(classifyItem(item), 'academica');
  });

  test('item web sin sector se clasifica por reglas (sin regresión)', () => {
    const item = { path: 'academica/plan.md', title: 'Plan', category: '' };
    assert.equal(classifyItem(item), 'academica');
  });
});

describe('overrides de taxonomía (alta prioridad sobre matchOrder)', () => {
  test('tecnicatura bajo academica/ va a oferta sin título (no a academica)', () => {
    // La web publica tecnicaturas bajo /academica/, pero son pregrado SIN título
    // de grado → el override las reasigna antes de la clasificación por carpeta.
    const item = {
      path: 'academica/tecnicatura-en-administracion-y-gestion-publica.md',
      title: 'Tecnicatura en Administración y Gestión Pública',
      category: 'Académica',
    };
    assert.equal(classifyItem(item), 'posgrados_cursos_sin_titulo');
  });

  test('doc académico sin "tecnicatura" sigue en academica (sin regresión)', () => {
    const item = {
      path: 'academica/contador-publico-nacional.md',
      title: 'Contador Público/ Contador Público Nacional',
      category: 'Académica',
    };
    assert.equal(classifyItem(item), 'academica');
  });

  test('item.sector explícito (Drive) gana sobre el override', () => {
    const item = {
      path: 'academica/tecnicatura-x.md',
      title: 'Tecnicatura en X',
      category: 'Académica',
      sector: 'academica',
    };
    assert.equal(classifyItem(item), 'academica');
  });
});

describe('cambio de planes 2027', () => {
  const doc = (slug, sector) => ({
    path: `complementos/15-cambio-de-planes-de-estudio-2027-${slug}.md`,
    title: slug,
    category: 'Complementario',
    sector,
  });

  test('la carpeta de Drive resuelve a academica sin pasar por la IA', () => {
    assert.equal(
      resolveSectorFromDrivePath('15-Cambio de Planes de Estudio 2027/nuevo/LA - transicion.pdf'),
      'academica',
    );
  });

  test('los planes de transición de las tres carreras quedan juntos en academica', () => {
    // El 31/10/2026 la IA dejó LA 778 en normativa y CP 777 / LE 779 en academica.
    for (const [slug, sector] of [
      ['nuevo-la-transicion-rdcd-fce-1305428-26-778', 'normativa'],
      ['nuevo-cp-transicion-rdcd-fce-1305430-26-777', 'academica'],
      ['nuevo-le-transicion-rdcd-fce-1305429-26-779', 'academica'],
    ]) {
      assert.equal(classifyItem(doc(slug, sector)), 'academica', slug);
    }
  });

  test('las correlatividades vigentes del plan anterior van a academica', () => {
    for (const slug of [
      'anterior-cpn-res-c-s-n-503-del-25-10-18-expte-n-fce-0941908-18-aprueba-correlatividades-contador-publico',
      'anterior-le-res-c-s-nordm-635-del-12-12-19-expte-nordm-fce-1013240-19-aprob-correlatividades-licenciatura-en-economia',
      'anterior-la-441-25-fce-1246305-25-correlatividades-lic-administracion',
    ]) {
      assert.equal(classifyItem(doc(slug, 'normativa')), 'academica', slug);
    }
  });

  test('el texto completo de un plan anterior sigue en normativa', () => {
    const item = doc(
      'anterior-cpn-res-c-s-nordm-502-del-25-10-18-expte-nordmfce-0941917-18-modificacion-plan-de-estudios-contador-publico',
      'academica',
    );
    assert.equal(classifyItem(item), 'normativa');
  });
});

describe('parseSectorResponse (fallback IA)', () => {
  test('JSON válido con confianza alta → sector elegido', () => {
    const out = parseSectorResponse('{"sector":"docentes","confidence":0.9}');
    assert.equal(out, 'docentes');
  });

  test('respuesta envuelta en fence ```json se desenvuelve', () => {
    const text = '```json\n{"sector":"ciencia","confidence":0.8}\n```';
    assert.equal(parseSectorResponse(text), 'ciencia');
  });

  test('confianza por debajo del umbral → fallbackSector', () => {
    const out = parseSectorResponse('{"sector":"docentes","confidence":0.3}');
    assert.equal(out, 'tramites_bedelia');
  });

  test('sector inexistente en la taxonomía → fallbackSector', () => {
    const out = parseSectorResponse('{"sector":"marketing","confidence":0.99}');
    assert.equal(out, 'tramites_bedelia');
  });

  test('texto no parseable → fallbackSector', () => {
    assert.equal(parseSectorResponse('no soy json'), 'tramites_bedelia');
    assert.equal(parseSectorResponse(''), 'tramites_bedelia');
    assert.equal(parseSectorResponse(null), 'tramites_bedelia');
  });

  test('umbral configurable via minConfidence', () => {
    const out = parseSectorResponse('{"sector":"docentes","confidence":0.5}', { minConfidence: 0.4 });
    assert.equal(out, 'docentes');
  });
});
