import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyItem,
  resolveSectorFromDrivePath,
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
