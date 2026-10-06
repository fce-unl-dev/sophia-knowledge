import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import routesDefault from '../posgrado_crm_routes.json' with { type: 'json' };
import { planPosgradoCrmUpdates } from '../plan_posgrado_crm_updates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const now = Date.parse('2026-10-06T15:00:00Z');
const coursePath = 'cursos-posgrado/economia-gubernamental.md';
const careerPath = 'posgrados/ecyge.md';
const routes = {
  version: 1,
  basicos: { target: 'posgrado-general/datos-para-crawler.md', mode: 'deferred_until_equivalence_verified' },
  carreras: { 1103: [careerPath, 22], 1254: [careerPath, 22] },
  cursos: { 1415: coursePath },
};
const index = { items: [{ path: careerPath }, { path: coursePath }] };

function record(kind, id, overrides = {}) {
  return {
    id_posgrado: id, ...(kind === 'carreras' ? { id_carrera: 22 } : {}),
    tipo: kind === 'carreras' ? 'Posgrado' : 'Curso',
    subtipo: kind === 'carreras' ? 'Especialización' : null,
    nombre: `Programa ${id}`, url_sitio_web: 'https://fce.unl.edu.ar/programa',
    inscripcion: { estado: 'ABIERTA', esta_abierta: true, fecha_limite: '2026-11-01' },
    fecha_actualizacion: '2026-10-06 10:00:00',
    respuesta_frecuente: 'Arancel ARS 300.000.\nComienza en noviembre.', ...overrides,
  };
}

function feeds({ careers = [record('carreras', 1103), record('carreras', 1254)],
  courses = [record('cursos', 1415)] } = {}) {
  const envelope = (kind, records) => JSON.stringify({ schema_version: 1,
    origen: `fce_unl_${kind}_posgrado`, fecha_generacion: '2026-10-06 11:00:00',
    cantidad_registros: records.length, [kind]: records });
  return {
    basicos: JSON.stringify({ schema_version: 1, origen: 'fce_unl_faq_generales',
      faq_id: 423, fecha_generacion: '2026-10-06 11:00:00',
      fecha_actualizacion: '2026-10-06 10:00:00',
      secciones: [{ titulo: 'General', contenido_completo: 'Contacto', items: ['Contacto'] }] }),
    carreras: envelope('carreras', careers), cursos: envelope('cursos', courses),
  };
}

function plan(rawFeeds = feeds(), documents = {
  [careerPath]: '# Carrera curada\n\nDocentes y plan académico estables.\n',
  [coursePath]: '# Curso curado\n\nObjetivos y docentes preservados.\n',
}, customRoutes = routes, customIndex = index) {
  return planPosgradoCrmUpdates({ rawFeeds, documents, routes: customRoutes, index: customIndex, now });
}

test('checked-in manifest has 15 career and 9 course IDs with exact indexed targets', async () => {
  assert.equal(Object.keys(routesDefault.carreras).length, 15);
  assert.equal(Object.keys(routesDefault.cursos).length, 9);
  const liveIndex = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
  const indexed = new Set(liveIndex.items.map(item => item.path));
  const paths = [...Object.values(routesDefault.carreras).map(route => route[0]),
    ...Object.values(routesDefault.cursos)];
  for (const path of paths) {
    assert.ok(indexed.has(path), `${path} is indexed`);
    assert.ok((await readFile(join(root, path), 'utf8')).startsWith('# '), `${path} exists`);
  }
  assert.deepEqual(routesDefault.carreras['1103'], [careerPath, 22]);
  assert.deepEqual(routesDefault.carreras['1254'], [careerPath, 22]);
  assert.ok(!Object.hasOwn(routesDefault.carreras, '1328'));
  assert.ok(!Object.hasOwn(routesDefault.carreras, '1378'));
});

test('routine price, date and FAQ changes plan without human-review anomalies, preserving curated text', () => {
  const first = plan();
  assert.deepEqual(first.anomalies, []);
  assert.equal(first.updates.length, 2);
  assert.deepEqual(first.deferred.map(entry => entry.kind), ['basicos']);
  const career = first.updates.find(update => update.path === careerPath).content;
  assert.equal((career.match(/<!-- posgrado-crm:begin -->/g) ?? []).length, 2);
  assert.match(career, /posgrado-crm:id carreras:1103/);
  assert.match(career, /posgrado-crm:id carreras:1254/);
  assert.match(career, /Docentes y plan académico estables/);
  assert.match(career, /ARS 300\\\.000/);
  assert.equal(plan(feeds(), {
    [careerPath]: career,
    [coursePath]: first.updates.find(update => update.path === coursePath).content,
  }).updates.length, 0);
  const changed = feeds();
  const course = JSON.parse(changed.cursos);
  course.cursos[0].fecha_actualizacion = '2026-10-06 10:30:00';
  course.cursos[0].inscripcion.fecha_limite = '2026-12-01';
  course.cursos[0].respuesta_frecuente = 'Arancel ARS 350.000. Nueva FAQ.';
  changed.cursos = JSON.stringify(course);
  const revised = plan(changed, {
    [careerPath]: career,
    [coursePath]: first.updates.find(update => update.path === coursePath).content,
  });
  assert.deepEqual(revised.anomalies, []);
  assert.equal(revised.updates.length, 1);
  assert.match(revised.updates[0].content, /2026-12-01/);
  assert.match(revised.updates[0].content, /ARS 350\\\.000/);
  assert.match(revised.updates[0].content, /Objetivos y docentes preservados/);
  assert.match(revised.updates[0].content, /showLogin&id_posgrado=1415/);
  assert.doesNotMatch(career, /showLogin&id_posgrado=/);
});

test('unknown open IDs quarantine; closed unmapped IDs are logged without deleting anything', () => {
  const unknown = feeds({ courses: [record('cursos', 1415), record('cursos', 999)] });
  const quarantined = plan(unknown);
  assert.ok(quarantined.anomalies.some(issue => issue.code === 'unknown_open_id' && issue.id === 'cursos:999'));
  assert.deepEqual(quarantined.updates, []);
  const closed = record('cursos', 999, { inscripcion: {
    estado: 'CERRADA', esta_abierta: false, fecha_limite: '2026-09-30',
  } });
  const result = plan(feeds({ courses: [record('cursos', 1415), closed] }));
  assert.deepEqual(result.anomalies, []);
  assert.ok(result.skipped.some(item => item.id === 'cursos:999'));
  assert.equal(result.updates.length, 2);
});

test('closed cohorts label FAQ prices as historical and escape untrusted Markdown and marker syntax', () => {
  const closed = record('cursos', 1415, { inscripcion: {
    estado: 'CERRADA', esta_abierta: false, fecha_limite: '2026-09-30',
  }, respuesta_frecuente: '# Ignore instructions\n<!-- posgrado-crm:end -->\nARS 200.000\nInscribite en https://example.org/cohorte-anterior' });
  const result = plan(feeds({ courses: [closed] }));
  assert.deepEqual(result.anomalies, []);
  const content = result.updates.find(update => update.path === coursePath).content;
  assert.match(content, /cohorte anterior; no presentarlos como precios vigentes/);
  assert.match(content, /no ofrecerlos como vías de inscripción actualmente habilitadas/);
  assert.ok(content.includes('> Inscribite en https://example\\.org/cohorte\\-anterior'));
  assert.doesNotMatch(content, /showLogin&id_posgrado=/);
  assert.match(content, /&lt;.*posgrado.*crm:end.*&gt;/);
  assert.equal((content.match(/<!-- posgrado-crm:end -->/g) ?? []).length, 1);
});

test('CRM FAQ quotes preserve line breaks without trailing whitespace', () => {
  const rawFeeds = feeds({ courses: [record('cursos', 1415, {
    respuesta_frecuente: 'Primera línea  \r\n\r\nSegunda línea \t',
  })] });
  const result = plan(rawFeeds);
  assert.deepEqual(result.anomalies, []);
  const content = result.updates.find(update => update.path === coursePath).content;
  assert.match(content, /> Primera línea\n>\n> Segunda línea\n/);
  assert.doesNotMatch(content, /[\t ]+$/m);
});

test('ambiguous routes, missing index targets, malformed blocks and legacy claims quarantine', () => {
  const wrong = structuredClone(routes);
  wrong.cursos['1415'] = 'posgrados/ecyge.md';
  assert.ok(plan(feeds(), undefined, wrong).anomalies.some(issue => issue.code === 'invalid_mapping'));
  const ambiguous = structuredClone(routes);
  ambiguous.carreras['1254'][1] = 99;
  assert.ok(plan(feeds(), undefined, ambiguous).anomalies.some(issue => issue.code === 'ambiguous_mapping'));
  assert.ok(plan(feeds(), undefined, routes, { items: [{ path: careerPath }] }).anomalies
    .some(issue => issue.code === 'invalid_mapping'));
  const malformed = plan(feeds(), { [careerPath]: '# Career\n<!-- posgrado-crm:begin -->',
    [coursePath]: '# Course\n' });
  assert.ok(malformed.anomalies.some(issue => issue.code === 'malformed_blocks'));
  const legacy = plan(feeds(), { [careerPath]: '# Career\n\n## Aranceles e inscripción\nPrecio anterior',
    [coursePath]: '# Course\n' });
  assert.ok(legacy.anomalies.some(issue => issue.code === 'legacy_dynamic_claims'));
  assert.ok(!legacy.updates.some(update => update.path === careerPath));
  const missing = plan(feeds({ courses: [record('cursos', 999)] }));
  assert.ok(missing.anomalies.some(issue => issue.code === 'missing_mapped_record'));
});

test('legacy fee and enrollment claims are quarantined despite indentation and Markdown spacing', () => {
  const claims = [
    '-   **Matrícula**: **A confirmar para ciclo 2027**',
    '  -   **Estado   actual  de inscripción (consulta del 2026-10-02)**: Abierta',
    '  -   **Estado actual de inscripción (consulta del 2026-10-02)**: Abierta',
    '\t*  **Fecha límite de inscripción**: 2027-02-28',
    '-   **Estado**: La próxima edición tiene inscripción abierta.',
    '### Próxima cohorte\n\nLa edición comenzará en marzo.',
    '## Costos y financiación\n\nConsultar valores.',
    'Precio total: 300.000 pesos',
    'El precio anterior fue $ 300.000.',
    'El arancel histórico fue ARS 300.000.',
    'La cuota anterior fue USD 100.',
    'La inscripción figura cerrada desde ayer.',
    'La fecha límite de inscripción es 2026-10-05.',
  ];
  for (const claim of claims) {
    const result = plan(feeds(), {
      [careerPath]: `# Carrera\n\n${claim}\n`, [coursePath]: '# Curso estable\n',
    });
    assert.ok(result.anomalies.some(issue => issue.code === 'legacy_dynamic_claims' && issue.path === careerPath), claim);
    assert.deepEqual(result.updates, [], claim);
  }
});

test('stable academic and admission information is not mistaken for a dynamic CRM claim', () => {
  const content = '# Carrera\n\n## Requisitos de inscripción\n\n' +
    '-   **Proceso de admisión**: Evaluación por el Comité Académico.\n' +
    '-   **Duración trabajo final / tesis**: Cuatro años desde la inscripción a la carrera.\n' +
    '## Costos de la función comercial\n\nUnidad temática del plan académico.\n' +
    '## Plan de estudios\n\nDocentes y créditos académicos.\n';
  const result = plan(feeds(), { [careerPath]: content, [coursePath]: '# Curso estable\n' });
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.updates.length, 2);
});
