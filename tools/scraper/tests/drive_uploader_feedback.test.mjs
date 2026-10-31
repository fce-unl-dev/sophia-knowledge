// Aviso a quien subió cada documento a Drive: controles previos, armado de los
// mensajes, envío y conexión con la ingesta. Los nombres de archivo son reales;
// las personas, ficticias.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkUploadHygiene, fileSummary, personalDataWarning, scanPersonalData, uploaderOf } from '../drive_upload_checks.mjs';
import { buildNotifications, markSent, noticeKey } from '../drive_notifications.mjs';
import { sendNotifications } from '../send_drive_notifications.mjs';
import { diagnoseDriveError } from '../drive_quarantine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ana = { displayName: 'Ana Pérez', emailAddress: 'ana@example.org' };
const juan = { displayName: 'Juan Gómez', emailAddress: 'juan@example.org' };
const file = (overrides) => ({
  id: 'id-1', name: 'CP 482.pdf', path: '15-Cambio de Planes de Estudio 2027/nuevo/CP 482.pdf',
  modifiedTime: '2026-10-29T20:00:00Z', webViewLink: 'https://drive.google.com/file/d/id-1/view',
  lastModifyingUser: ana, ...overrides,
});

describe('quién subió el archivo', () => {
  test('usa a quien lo modificó por última vez y, si falta, al dueño', () => {
    assert.deepEqual(uploaderOf(file()), { name: 'Ana Pérez', email: 'ana@example.org' });
    assert.deepEqual(uploaderOf(file({ lastModifyingUser: { displayName: 'Sin mail' }, owners: [juan] })), { name: 'Juan Gómez', email: 'juan@example.org' });
    assert.equal(uploaderOf(file({ lastModifyingUser: undefined })), null);
  });

  test('el diagnóstico de errores incluye id, versión y persona', () => {
    const error = diagnoseDriveError(file(), 'This operation was aborted');
    assert.equal(error.id, 'id-1');
    assert.equal(error.modifiedTime, '2026-10-29T20:00:00Z');
    assert.equal(error.uploader.email, 'ana@example.org');
  });
});

describe('controles previos', () => {
  test('archivo suelto en la carpeta principal y nombres genéricos', () => {
    const warnings = checkUploadHygiene([
      file({ id: 'a', name: 'documento final (2).pdf', path: 'documento final (2).pdf' }),
      file({ id: 'b', name: 'Copia de Res. CS 481-26.pdf', path: '02-Grado/Copia de Res. CS 481-26.pdf' }),
      file({ id: 'c', name: 'Res. CS 481-26 Plan Contador Público 2027.pdf', path: '02-Grado/Res. CS 481-26 Plan Contador Público 2027.pdf' }),
    ]);
    assert.deepEqual(warnings.map((w) => [w.id, w.kind]), [['a', 'carpeta-raiz'], ['a', 'nombre-generico'], ['b', 'nombre-generico']]);
  });

  test('una versión nueva subida como archivo aparte se avisa sobre la más reciente', () => {
    const warnings = checkUploadHygiene([
      file({ id: 'viejo', name: 'Info costos carrera para la IA.xlsx', path: '04-Posgrado/Info costos carrera para la IA.xlsx', modifiedTime: '2026-10-01T00:00:00Z' }),
      file({ id: 'nuevo', name: 'Info costos carrera para la IA', path: '04-Posgrado/Info costos carrera para la IA', modifiedTime: '2026-10-30T00:00:00Z' }),
      file({ id: 'otra-carpeta', name: 'Info costos carrera para la IA', path: '02-Grado/Info costos carrera para la IA' }),
    ]);
    assert.deepEqual(warnings.map((w) => [w.id, w.kind]), [['nuevo', 'posible-duplicado']]);
    assert.match(warnings[0].advice, /Administrar versiones/);
  });

  test('datos personales con señales fuertes, no los institucionales', () => {
    assert.deepEqual(scanPersonalData('Alumno: Juan, DNI 30.123.456, legajo 12345, CUIL 20-30123456-7'), ['DNI', 'CUIL/CUIT', 'legajo']);
    assert.deepEqual(scanPersonalData('Consultas: posgrado@fce.unl.edu.ar · (0342) 4571180 · Res. CS 481/26'), []);
    const warning = personalDataWarning(file(), ['DNI']);
    assert.equal(warning.kind, 'datos-personales');
    assert.match(warning.advice, /todo lo que entra a la base de Luca es público/);
  });
});

describe('armado de los avisos', () => {
  const report = {
    errors: [diagnoseDriveError(file(), 'This operation was aborted')],
    warnings: [{ ...fileSummary(file({ id: 'id-2', name: 'documento (1).pdf', path: '02-Grado/documento (1).pdf', lastModifyingUser: juan })), kind: 'nombre-generico', advice: 'Usá un nombre descriptivo.' }],
    processed: [],
  };

  test('un mensaje por persona, con su problema y qué hacer', () => {
    const { messages } = buildNotifications(report, {});
    assert.equal(messages.length, 2);
    const forAna = messages.find((m) => m.to === 'ana@example.org');
    assert.match(forAna.subject, /1 documento\(s\) de Drive para revisar/);
    assert.match(forAna.text, /^Hola, Ana:/);
    assert.match(forAna.text, /CP 482\.pdf\n {2}Falla temporal|no hace falta hacer nada/);
    assert.match(forAna.text, /docs\.google\.com\/document\/d\/1UY93r6PzMZYImEofNAdZLNId3JxaBIjhuI8leb9SSH4/);
    assert.doesNotMatch(forAna.text, /documento \(1\)\.pdf/, 'cada persona recibe solo lo suyo');
  });

  test('no repite un aviso ya enviado para la misma versión', () => {
    const sent = { [noticeKey(report.errors[0])]: '2026-10-30T00:00:00Z', [noticeKey(report.warnings[0])]: '2026-10-30T00:00:00Z' };
    assert.equal(buildNotifications(report, sent, new Date('2026-10-31T00:00:00Z')).messages.length, 0);
    const nuevaVersion = { ...report, errors: [{ ...report.errors[0], modifiedTime: '2026-11-02T00:00:00Z' }] };
    assert.equal(buildNotifications(nuevaVersion, sent, new Date('2026-11-02T00:00:00Z')).messages.length, 1);
  });

  test('avisa "ya resuelto" solo si antes hubo un error, no una advertencia', () => {
    const sent = { [noticeKey(report.errors[0])]: '2026-10-30T00:00:00Z', [noticeKey(report.warnings[0])]: '2026-10-30T00:00:00Z' };
    const processed = [fileSummary(file({ modifiedTime: '2026-11-01T00:00:00Z' })), fileSummary(file({ id: 'id-2', lastModifyingUser: juan }))];
    const { messages } = buildNotifications({ errors: [], warnings: [], processed }, sent, new Date('2026-11-01T00:00:00Z'));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'ana@example.org');
    assert.match(messages[0].subject, /ya procesados/);
    assert.deepEqual(messages[0].keys, ['id-1:2026-11-01T00:00:00Z:resuelto']);
  });

  test('el estado guarda claves sin mails y se poda a los 180 días', () => {
    const { messages, state } = buildNotifications(report, { 'viejo:2026-01-01T00:00:00Z:otro': '2026-01-01T00:00:00Z' }, new Date('2026-10-31T00:00:00Z'));
    assert.deepEqual(state, {});
    const next = markSent(state, messages[0], new Date('2026-10-31T00:00:00Z'));
    assert.ok(Object.keys(next).length > 0);
    assert.doesNotMatch(JSON.stringify(next), /@/);
  });
});

describe('envío', () => {
  const report = { errors: [diagnoseDriveError(file(), 'This operation was aborted')], warnings: [], processed: [] };
  const smtp = { SMTP_HOST: 'smtp.example.org', SMTP_USER: 'bot', SMTP_PASSWORD: 'x', NOTIFICATION_EMAIL_FROM: 'luca@example.org', NOTIFICATION_EMAIL_TO: 'responsable@example.org' };
  const fakeTransport = () => {
    const mails = [];
    return { mails, createTransport: (options) => ({ options, sendMail: async (mail) => { mails.push(mail); } }) };
  };

  test('sin el interruptor solo muestra la vista previa y no toca el estado', async () => {
    const { mails, createTransport } = fakeTransport();
    const out = [];
    const result = await sendNotifications({ report, state: {}, env: smtp, createTransport, log: (line) => out.push(line) });
    assert.equal(mails.length, 0);
    assert.deepEqual(result.state, {});
    assert.match(out.join('\n'), /Ana Pérez: Luca: 1 documento/);
    assert.match(out.join('\n'), /Modo vista previa/);
    assert.doesNotMatch(out.join('\n'), /@/, 'el resumen del run es público: sin mails');
  });

  test('con el interruptor envía, copia al responsable y registra el aviso', async () => {
    const { mails, createTransport } = fakeTransport();
    const result = await sendNotifications({ report, state: {}, env: { ...smtp, DRIVE_NOTIFY_UPLOADERS: 'true' }, createTransport, log: () => {} });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ana@example.org');
    assert.equal(mails[0].cc, 'responsable@example.org');
    assert.equal(mails[0].attachments, undefined);
    assert.deepEqual(Object.keys(result.state), [noticeKey(report.errors[0])]);
  });

  test('las transcripciones rechazadas van solo al responsable, en un mail aparte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-rejected-'));
    await writeFile(join(dir, 'cp-482.md'), '<!-- lost-tables -->\n# CP 482');
    const { mails, createTransport } = fakeTransport();
    await sendNotifications({ report, state: {}, env: { ...smtp, DRIVE_NOTIFY_UPLOADERS: 'true' }, createTransport, rejectedDir: dir, log: () => {} });
    assert.equal(mails.length, 2);
    assert.equal(mails[1].to, 'responsable@example.org');
    assert.equal(mails[1].cc, undefined);
    assert.deepEqual(mails[1].attachments.map((a) => a.filename), ['cp-482.md']);
  });

  test('sin SMTP configurado no envía ni registra', async () => {
    const { mails, createTransport } = fakeTransport();
    const out = [];
    const result = await sendNotifications({ report, state: {}, env: { DRIVE_NOTIFY_UPLOADERS: 'true' }, createTransport, log: (line) => out.push(line) });
    assert.equal(mails.length, 0);
    assert.deepEqual(result.state, {});
    assert.match(out.join('\n'), /faltan SMTP_HOST, SMTP_USER, SMTP_PASSWORD, NOTIFICATION_EMAIL_FROM/);
  });

  test('un envío fallido no se registra y se reintenta en la próxima corrida', async () => {
    const createTransport = () => ({ sendMail: async () => { throw new Error('535 auth failed'); } });
    const out = [];
    const result = await sendNotifications({ report, state: {}, env: { ...smtp, DRIVE_NOTIFY_UPLOADERS: 'true' }, createTransport, log: (line) => out.push(line) });
    assert.deepEqual(result.state, {});
    assert.match(out.join('\n'), /No se pudo enviar el aviso de Ana Pérez: 535 auth failed/);
  });
});

describe('conexión con la ingesta', () => {
  test('el listado pide quién subió cada archivo y el reporte lleva procesados y avisos', async () => {
    const source = await readFile(join(here, '../scrape_drive.mjs'), 'utf8');
    assert.match(source, /lastModifyingUser\(displayName, emailAddress\), owners\(displayName, emailAddress\)/);
    assert.match(source, /const runWarnings = checkUploadHygiene\(driveFiles\);/);
    assert.match(source, /runWarnings\.push\(personalDataWarning\(file, personalData\)\)/);
    assert.match(source, /runProcessed\.push\(fileSummary\(file\)\);/);
  });

  test('el workflow avisa con interruptor y guarda el estado en su propia rama', async () => {
    const workflow = await readFile(join(here, '../../../.github/workflows/ingest-drive.yml'), 'utf8');
    const step = workflow.slice(workflow.indexOf('- name: Notify uploaders'), workflow.indexOf('- name: Fail on removal anomaly'));
    assert.match(step, /if: always\(\) && inputs\.mode != 'dry-run' && steps\.scrape\.outcome == 'success'/);
    assert.match(step, /DRIVE_NOTIFY_UPLOADERS: \$\{\{ vars\.DRIVE_NOTIFY_UPLOADERS \}\}/);
    assert.match(step, /SMTP_PASSWORD: \$\{\{ secrets\.SMTP_PASSWORD \}\}/);
    assert.match(step, /state_branch=drive-notifications-state/);
    assert.match(step, /git push --quiet origin "HEAD:refs\/heads\/\$state_branch"/);
  });
});
