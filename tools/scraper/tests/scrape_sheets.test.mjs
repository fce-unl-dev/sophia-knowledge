import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitDocentes,
  normalizeTeacherKey,
  generateScheduleByTeacherTable,
  generateSchedulesMarkdownTables,
  parseComisionesFromText,
} from '../scrape_sheets.mjs';

describe('splitDocentes', () => {
  test('separa co-docentes por <br>', () => {
    assert.deepEqual(
      splitDocentes('Claudia Zanabria<br> Lujan Alvarez'),
      ['Claudia Zanabria', 'Lujan Alvarez']
    );
  });

  test('separa por salto de línea y por punto y coma', () => {
    assert.deepEqual(splitDocentes('Ana Pérez\nLuis Gómez'), ['Ana Pérez', 'Luis Gómez']);
    assert.deepEqual(splitDocentes('Ana Pérez; Luis Gómez'), ['Ana Pérez', 'Luis Gómez']);
  });

  test('NO separa por coma (preserva "Apellido, Nombre")', () => {
    assert.deepEqual(splitDocentes('Marta, Nardoni'), ['Marta, Nardoni']);
  });

  test('descarta N/D y vacíos', () => {
    assert.deepEqual(splitDocentes('N/D'), []);
    assert.deepEqual(splitDocentes(''), []);
    assert.deepEqual(splitDocentes(null), []);
  });

  test('limpia guiones iniciales que trae la planilla', () => {
    assert.deepEqual(splitDocentes('- Emir Gabriel, Espinoza'), ['Emir Gabriel, Espinoza']);
    assert.deepEqual(splitDocentes('-Marcela, Bayones'), ['Marcela, Bayones']);
  });
});

describe('normalizeTeacherKey', () => {
  test('colapsa tildes, mayúsculas y espacios para agrupar', () => {
    assert.equal(normalizeTeacherKey('Pía Chiapero'), normalizeTeacherKey('PIA  CHIAPERO'));
    assert.equal(normalizeTeacherKey('  María   José  '), 'maria jose');
  });
});

describe('parseComisionesFromText (A2: desdoblar optativas multi-comisión)', () => {
  const liderazgo = 'C1 : Lunes 8 hs Profesora Luciana Bolea.\n\nC2: Martes 16:30 hs Profesora Patricia Coassin.\n\nC3: Jueves 19:30 hs Profesora Paula Raviolo.';

  test('separa las 3 comisiones de Liderazgo con su docente y horario', () => {
    const coms = parseComisionesFromText(liderazgo);
    assert.equal(coms.length, 3);
    assert.deepEqual(coms[0], { comision: 'C1', dia: 'Lunes', horario: '8 hs', docente: 'Luciana Bolea' });
    assert.deepEqual(coms[1], { comision: 'C2', dia: 'Martes', horario: '16:30 hs', docente: 'Patricia Coassin' });
    assert.deepEqual(coms[2], { comision: 'C3', dia: 'Jueves', horario: '19:30 hs', docente: 'Paula Raviolo' });
  });

  test('NO toca horarios simples (sin patrón Cn:)', () => {
    assert.deepEqual(parseComisionesFromText('Martes 19.30'), []);
    assert.deepEqual(parseComisionesFromText('Viernes 10.30 a 13.15hs'), []);
    assert.deepEqual(parseComisionesFromText('lunes 10:30 hs - Comienzo de clases 30/03'), []);
  });

  test('exige al menos 2 comisiones (una sola Cn: no se considera multi)', () => {
    assert.deepEqual(parseComisionesFromText('C1: Lunes 8 hs Profesora Bolea'), []);
  });

  test('si una comisión no tiene docente embebido, lo deja vacío (cae al de la columna)', () => {
    const coms = parseComisionesFromText('C1: Lunes 8 hs\nC2: Martes 10 hs');
    assert.equal(coms.length, 2);
    assert.equal(coms[0].docente, '');
    assert.equal(coms[0].dia, 'Lunes');
    assert.equal(coms[0].horario, '8 hs');
  });

  test('maneja vacío/null sin romper', () => {
    assert.deepEqual(parseComisionesFromText(''), []);
    assert.deepEqual(parseComisionesFromText(null), []);
  });
});

describe('generateScheduleByTeacherTable', () => {
  const schedules = [
    {
      tab: 'Ingresantes',
      ok: true,
      schedules: [
        { anio: 'Ingresantes', materia: '1015 - Matemática como Lenguaje', comision: 'Com. N° 3', dia: 'Lunes', horario: '10.30 - 13.15 hs', docente: 'Pía Chiapero' },
        { anio: 'Ingresantes', materia: '1015 - Matemática como Lenguaje', comision: 'Com. N° 3', dia: 'Miércoles', horario: '10.30 - 13.15 hs', docente: 'Pía Chiapero' },
        { anio: 'Ingresantes', materia: '1015 - Matemática como Lenguaje', comision: 'Com. N° 1', dia: 'Martes', horario: '10.30 - 13.15 hs', docente: 'Claudia Zanabria<br> Lujan Alvarez' },
      ],
    },
    {
      tab: 'Optativas',
      ok: true,
      schedules: [
        { anio: 'Optativas', materia: 'PLANIFICANDO ESTRATEGIAS', comision: 'Única', dia: 'Ver horarios', horario: 'Martes 19.30', docente: 'María Ofelia Raigada' },
      ],
    },
    { tab: 'Roto', ok: false, schedules: [] },
  ];

  test('indexa cada docente con su materia y comisión', () => {
    const md = generateScheduleByTeacherTable(schedules);
    assert.match(md, /\| Docente \| Materia \| Comisión \| Día y Horario \|/);
    // Chiapero aparece enlazada a su materia (resuelve el patrón de queja)
    assert.match(md, /Pía Chiapero \| 1015 - Matemática como Lenguaje \| Com\. N° 3/);
  });

  test('desdobla co-docentes de una misma celda en filas separadas', () => {
    const md = generateScheduleByTeacherTable(schedules);
    assert.match(md, /Claudia Zanabria \| 1015/);
    assert.match(md, /Lujan Alvarez \| 1015/);
  });

  test('para optativas con día placeholder muestra solo el horario', () => {
    const md = generateScheduleByTeacherTable(schedules);
    assert.match(md, /María Ofelia Raigada \| PLANIFICANDO ESTRATEGIAS \| Única \| Martes 19\.30 \|/);
    assert.doesNotMatch(md, /Ver horarios/);
  });

  test('deduplica filas idénticas del mismo docente (mismo día/horario repetido)', () => {
    const dupes = [{
      tab: 'X', ok: true, schedules: [
        { materia: 'M', comision: 'C1', dia: 'Lunes', horario: '8hs', docente: 'Juan Perez' },
        { materia: 'M', comision: 'C1', dia: 'Lunes', horario: '8hs', docente: 'Juan Perez' },
      ],
    }];
    const md = generateScheduleByTeacherTable(dupes);
    const matches = md.match(/Juan Perez \| M \| C1 \| Lunes — 8hs/g) || [];
    assert.equal(matches.length, 1);
  });

  test('una celda sucia con saltos de línea NO rompe la tabla (queda en 1 fila)', () => {
    const dirty = [{
      tab: 'Optativas', ok: true, schedules: [
        { materia: 'Liderazgo', comision: 'Única', dia: 'Ver horarios', horario: 'C1: Lunes 8hs Prof Bolea.\nC3: Jueves 19:30 Prof Raviolo.', docente: 'Paula Raviolo' },
      ],
    }];
    const md = generateScheduleByTeacherTable(dirty);
    const dataRows = md.split('\n').slice(2); // sin header ni separador
    assert.equal(dataRows.length, 1, 'la fila sucia debe quedar en una sola línea');
    assert.match(dataRows[0], /Bolea.*Raviolo/); // ambas comisiones quedan en la misma fila, sin salto interno
  });

  test('ignora pestañas con ok:false y maneja entrada vacía', () => {
    assert.match(generateScheduleByTeacherTable([]), /No hay horarios/);
    assert.match(generateScheduleByTeacherTable([{ tab: 'X', ok: false, schedules: [] }]), /No hay docentes|No hay horarios/);
  });
});

describe('generateSchedulesMarkdownTables (regresión: no se rompió la tabla por materia)', () => {
  test('sigue generando la tabla agrupada por materia', () => {
    const md = generateSchedulesMarkdownTables([
      { materia: 'Contabilidad I', comision: 'Com. N° 1', dia: 'Lunes', horario: '8hs', docente: 'Ana' },
    ]);
    assert.match(md, /#### Contabilidad I/);
    assert.match(md, /\| Com\. N° 1 \| Lunes \| 8hs \| Ana \|/);
  });
});
