// Envía los avisos de la ingesta de Drive a quienes subieron los documentos.
//
//   node send_drive_notifications.mjs <reporte.json> <estado.json> [rechazados/]
//
// Solo envía si DRIVE_NOTIFY_UPLOADERS=true (variable del repo que controla la
// Facultad); si no, muestra qué se enviaría y no toca el estado, así el primer
// envío real incluye todo lo pendiente. Lo que imprime va al resumen público
// del run: nombres de archivo y personas, nunca direcciones de mail.
//
// Env: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD,
//      NOTIFICATION_EMAIL_FROM, NOTIFICATION_EMAIL_TO (responsable, en copia).

import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNotifications, markSent } from './drive_notifications.mjs';

// Las transcripciones rechazadas van solo al responsable, por mail: el repo es
// público y como artefacto del run quedarían a la vista de cualquiera.
export function rejectedAttachments(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => ({ filename: name, path: join(dir, name) }));
}

export async function sendNotifications({ report, state, env = process.env, createTransport, rejectedDir, now = new Date(), log = console.log }) {
  const { messages, state: pruned } = buildNotifications(report, state, now);
  const enabled = env.DRIVE_NOTIFY_UPLOADERS === 'true';
  log(`## Avisos a quienes subieron documentos\n`);
  if (!messages.length) {
    log('No hay avisos nuevos.');
    return { state: pruned, sent: 0 };
  }
  for (const message of messages) {
    log(`- ${message.name || 'Responsable (sin persona identificada)'}: ${message.subject} (${message.paths.join('; ')})`);
  }
  if (!enabled) {
    log('\nModo vista previa: `DRIVE_NOTIFY_UPLOADERS` no está en `true`, no se envió nada.');
    return { state, sent: 0 };
  }
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'NOTIFICATION_EMAIL_FROM'].filter((name) => !env[name]);
  if (missing.length) {
    log(`\nNo se enviaron avisos: faltan ${missing.join(', ')}.`);
    return { state, sent: 0 };
  }
  const transport = createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: Number(env.SMTP_PORT) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  let next = pruned;
  let sent = 0;
  for (const message of messages) {
    const to = message.to || env.NOTIFICATION_EMAIL_TO;
    if (!to) continue;
    const cc = message.to && env.NOTIFICATION_EMAIL_TO ? env.NOTIFICATION_EMAIL_TO : undefined;
    try {
      await transport.sendMail({ from: env.NOTIFICATION_EMAIL_FROM, to, cc, subject: message.subject, text: message.text });
      next = markSent(next, message, now);
      sent++;
    } catch (error) {
      log(`- No se pudo enviar el aviso de ${message.name || 'responsable'}: ${error.message}`);
    }
  }

  // Cada persona recibe solo lo suyo: las transcripciones rechazadas van en un
  // mail aparte, únicamente al responsable, para diagnosticar.
  const attachments = rejectedAttachments(rejectedDir);
  if (sent && attachments.length && env.NOTIFICATION_EMAIL_TO) {
    try {
      await transport.sendMail({
        from: env.NOTIFICATION_EMAIL_FROM,
        to: env.NOTIFICATION_EMAIL_TO,
        subject: `Luca: ${attachments.length} transcripción(es) rechazada(s) por las guardas`,
        text: 'Adjunto lo que escribió el modelo en los documentos que la ingesta de Drive rechazó en esta corrida, con el motivo al comienzo de cada archivo.',
        attachments,
      });
    } catch (error) {
      log(`- No se pudieron enviar las transcripciones rechazadas: ${error.message}`);
    }
  }
  log(`\n${sent} aviso(s) enviado(s).`);
  return { state: next, sent };
}

async function main([reportPath, statePath, rejectedDir]) {
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : {};
  const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, 'utf8') || '{}') : {};
  const { default: nodemailer } = await import('nodemailer');
  const result = await sendNotifications({ report, state, rejectedDir, createTransport: nodemailer.createTransport });
  await writeFile(statePath, JSON.stringify(result.state, null, 2) + '\n', 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
