import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeKbMarkdown } from '../scrape_drive.mjs';

describe('sanitizeKbMarkdown', () => {
  test('colapsa un run gigante de guiones (caso real: separador de 214K)', () => {
    const giant = '| :' + '-'.repeat(214000) + ' |';
    const out = sanitizeKbMarkdown(giant);
    assert.ok(out.length < 60, `esperaba línea corta, quedó ${out.length}`);
    assert.equal(out, '| :--- |');
  });

  test('preserva una fila separadora de tabla normal', () => {
    const md = '| Asignatura | Correlativa |\n| :--- | :--- |\n| Contab I | - |';
    assert.equal(sanitizeKbMarkdown(md), md);
  });

  test('no toca el divisor markdown de 3 guiones (hr)', () => {
    assert.equal(sanitizeKbMarkdown('texto\n\n---\n\nmás texto'), 'texto\n\n---\n\nmás texto');
  });

  test('colapsa ":-----" a ":---" y "-----" a "---"', () => {
    assert.equal(sanitizeKbMarkdown('| :--------- | ----------- |'), '| :--- | --- |');
  });

  test('no rompe contenido legítimo con guiones (palabras, fechas)', () => {
    const md = 'Plan 2018-19, expte FCE-0941908-18, correo a-b-c@unl.edu.ar';
    assert.equal(sanitizeKbMarkdown(md), md);
  });

  test('colapsa runs de = y _ , y relleno de espacios', () => {
    assert.equal(sanitizeKbMarkdown('a' + '='.repeat(50) + 'b'), 'a===b');
    assert.equal(sanitizeKbMarkdown('x' + '_'.repeat(30) + 'y'), 'x___y');
    assert.equal(sanitizeKbMarkdown('p' + ' '.repeat(200) + 'q'), 'p q');
  });

  test('maneja entradas no-string sin romper', () => {
    assert.equal(sanitizeKbMarkdown(''), '');
    assert.equal(sanitizeKbMarkdown(null), null);
    assert.equal(sanitizeKbMarkdown(undefined), undefined);
  });
});
