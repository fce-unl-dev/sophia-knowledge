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
