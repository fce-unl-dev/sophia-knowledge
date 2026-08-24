// Parseo del listado de cursos de formación.
//
// El fixture es una captura literal del listado oficial al 24/08/2026, tomada de
// https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showCursos
//
// Este archivo no existía, y por eso el 14/08/2026 la página pudo agregarle un
// atributo al div de cada tarjeta y dejar el parser en cero sin que nada
// fallara: los runs siguieron en verde, el scraper devolvió 0 cursos activos y
// recién se notó mirando el catálogo a mano.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCourseList } from '../scrape_courses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/cursos-de-formacion-listado.html');
const BASE = 'https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showCursos';

const html = await readFile(FIXTURE, 'utf8');

describe('parseCourseList — listado oficial del 24/08/2026', () => {
  test('encuentra las 13 tarjetas publicadas', () => {
    const courses = parseCourseList(html, BASE);
    assert.equal(courses.length, 13);
    // Tantas tarjetas como divs de curso trae el HTML: si el parser deja alguna
    // afuera, no alcanza con contar los que sí salieron.
    const cards = (html.match(/<div[^>]*class=['"]curso['"][^>]*>/gi) || []).length;
    assert.equal(courses.length, cards);
  });

  test('toma las dos con inscripción abierta con su fecha de inicio', () => {
    const conFecha = parseCourseList(html, BASE).filter((c) => c.start_date);
    assert.deepEqual(
      conFecha.map((c) => [c.slug, c.start_date]),
      [
        ['planillas-de-calculo-para-gestionar-tu-emprendimiento', '2026-08-24'],
        ['la-construccion-del-pensamiento-proporcional', '2026-08-31'],
      ],
    );
  });

  test('las once sin inscripción también entran, sin fecha', () => {
    const sinFecha = parseCourseList(html, BASE).filter((c) => !c.start_date);
    assert.equal(sinFecha.length, 11);
    // Capturarlas es lo que permite que el auto-borrado de bajas sea seguro: si
    // el parser solo viera las abiertas, las otras once se irían del KB.
    for (const course of sinFecha) {
      assert.ok(course.title, 'toda tarjeta tiene título');
      assert.ok(course.detail_url, 'toda tarjeta tiene link de detalle');
    }
  });

  test('curso con inscripción abierta: todos los campos', () => {
    const course = parseCourseList(html, BASE)
      .find((c) => c.slug === 'planillas-de-calculo-para-gestionar-tu-emprendimiento');
    assert.equal(course.title, 'PLANILLAS DE CÁLCULO PARA GESTIONAR TU EMPRENDIMIENTO');
    assert.equal(course.normalized_title, 'planillas de calculo para gestionar tu emprendimiento');
    assert.equal(course.start_date, '2026-08-24');
    assert.equal(course.detail_id, '265');
    assert.equal(course.course_id, '1174');
    assert.equal(course.detail_url, 'https://www.fce.unl.edu.ar/cursos-de-formacion/index.php?act=showSubcategoria&id=265');
    assert.equal(course.query_url, 'https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showFormularioI&idCurso=1174#superior');
    assert.equal(course.signup_url, 'https://www.fce.unl.edu.ar/cursos_formacion/index.php?act=showLogin&id_curso=1174#superior');
  });

  test('curso sin inscripción: sin fecha ni pre-inscripción, con detalle y consultas', () => {
    const course = parseCourseList(html, BASE)
      .find((c) => c.slug === 'formacion-de-repositores-para-supermercado');
    assert.equal(course.start_date, null);
    assert.equal(course.signup_url, null);
    assert.equal(course.detail_url, 'https://www.fce.unl.edu.ar/cursos-de-formacion/index.php?act=showSubcategoria&id=308');
    assert.equal(course.query_url, 'https://www.fce.unl.edu.ar/cursos_de_formacion/index.php?act=showFormularioI&idCurso=1187#superior');
  });

  test('los tres hosts que conviven en la página se resuelven cada uno como corresponde', () => {
    // No es un detalle cosmético: el listado sirve links a tres rutas distintas
    // y dos difieren solo en un guión.
    const course = parseCourseList(html, BASE).find((c) => c.detail_id === '265');
    assert.match(course.detail_url, /\/cursos-de-formacion\//, 'el detalle va con guiones, absoluto en el HTML');
    assert.match(course.query_url, /\/cursos_de_formacion\//, 'consultas es relativo y resuelve contra el base, con guión bajo');
    assert.match(course.signup_url, /\/cursos_formacion\//, 'pre-inscripción cuelga de ../cursos_formacion/');
  });

  test('no repite cursos', () => {
    const courses = parseCourseList(html, BASE);
    const ids = courses.map((c) => c.detail_id);
    const slugs = courses.map((c) => c.slug);
    assert.equal(new Set(ids).size, ids.length, 'detail_id repetido');
    assert.equal(new Set(slugs).size, slugs.length, 'slug repetido');
  });

  test('ninguna tarjeta sale sin título ni sin slug', () => {
    for (const course of parseCourseList(html, BASE)) {
      assert.ok(course.title.length > 0, `título vacío en ${course.detail_id}`);
      assert.ok(course.slug.length > 0, `slug vacío en ${course.detail_id}`);
    }
  });
});

describe('parseCourseList — tolerancia al markup', () => {
  const tarjeta = (divTag) => `${divTag}
    <img src='uploads/encabezados/999.jpg' />
    <p><b>CURSO DE PRUEBA</b></p>Inicio:<b>01/09/2026</b>.
    <a href='https://www.fce.unl.edu.ar/cursos-de-formacion/index.php?act=showSubcategoria&id=777'>Más información</a>
    <div class='inferior'>
      <a href='index.php?act=showFormularioI&idCurso=999#superior'>Consultas</a>
    </div>
  </div>`;

  // Esta es la regresión concreta: el 14/08/2026 la página le agregó
  // data-origen='fce' al div de la tarjeta. El split literal por
  // <div class='curso'> dejó de matchear y el parser devolvió cero.
  test('una tarjeta con atributos extra en el div sigue parseando', () => {
    const courses = parseCourseList(tarjeta(`<div class='curso' data-origen='fce'>`), BASE);
    assert.equal(courses.length, 1);
    assert.equal(courses[0].slug, 'curso-de-prueba');
    assert.equal(courses[0].detail_id, '777');
  });

  test('sigue andando el markup viejo, sin atributos', () => {
    const courses = parseCourseList(tarjeta(`<div class='curso'>`), BASE);
    assert.equal(courses.length, 1);
    assert.equal(courses[0].detail_id, '777');
  });

  test('tolera comillas dobles y atributos antes de la clase', () => {
    const courses = parseCourseList(tarjeta(`<div data-origen="fce" class="curso" id="c777">`), BASE);
    assert.equal(courses.length, 1);
    assert.equal(courses[0].detail_id, '777');
  });

  test('el botón de consultas se toma con el patrón actual y con el viejo', () => {
    const actual = parseCourseList(tarjeta(`<div class='curso' data-origen='fce'>`), BASE);
    assert.match(actual[0].query_url, /act=showFormularioI&idCurso=999/);

    const viejo = parseCourseList(
      tarjeta(`<div class='curso'>`).replace('act=showFormularioI&idCurso=999', 'act=showConsulta&id=999'),
      BASE,
    );
    assert.match(viejo[0].query_url, /act=showConsulta&id=999/);
  });

  test('un HTML sin tarjetas devuelve lista vacía, no rompe', () => {
    assert.deepEqual(parseCourseList('<html><body>nada</body></html>', BASE), []);
  });
});
