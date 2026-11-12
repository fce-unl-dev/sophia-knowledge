import { decodeEntities, htmlToText } from './scrape.mjs';

export const AGENDA_URL = 'https://www.fce.unl.edu.ar/eventos/';
export const MAX_AGENDA_EVENTS = 30;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_SOURCE_ROWS = 200;
const AGENDA_ORIGIN = new URL(AGENDA_URL).origin;

const fail = reason => ({ status: 'invalid', events: [], reason });

function dateIso(year, month, day) {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day && date.getUTCMonth() + 1 === month
    ? date.toISOString().slice(0, 10) : null;
}

function attribute(tag, name) {
  const match = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'\`=<>]+))', 'i'));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function eventUrl(raw) {
  if (!raw || raw.length > 2048) return null;
  const href = decodeEntities(raw).trim();
  if (!href || href.startsWith('#') || /[\p{Cc}\s]/u.test(href)) return null;
  let url;
  try {
    url = new URL(href, AGENDA_URL);
  } catch {
    return null;
  }
  if (url.origin !== AGENDA_ORIGIN || url.username || url.password || url.pathname === '/') return null;

  // Preserve only the query identifiers used by the official list. Do not
  // propagate tracking or unrelated query parameters into the knowledge base.
  const path = url.pathname.replace(/\/$/, '');
  const idKey = path === '/eventos/index.php' || path === '/eventos' ? 'idEvento'
    : path === '/ver-noticia' ? 'nid' : null;
  const id = idKey && url.searchParams.get(idKey);
  if (idKey && (!id || !/^[1-9]\d*$/.test(id) || url.searchParams.getAll(idKey).length !== 1)) return null;
  url.hash = '';
  url.search = '';
  if (idKey) url.searchParams.set(idKey, id);
  // Keep emitted destinations compatible with Luca's literal Markdown links.
  const canonical = url.href;
  if (canonical.length > 2048 || /[()<>"'\x60\\\s\p{Cc}\p{Cf}]/u.test(canonical)) return null;
  return canonical;
}

function collectRows(html) {
  const divTags = /<\/?div(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const rows = [];
  let level = 0;
  let pageLevel = null;
  let list = null;
  let row = null;
  let lastEnd = 0;
  let remainder = '';
  let completed = false;
  let pageCompleted = false;

  for (const tag of html.matchAll(divTags)) {
    const index = tag.index;
    const end = index + tag[0].length;
    if (tag[0].startsWith('</')) {
      if (row?.level === level) {
        if (index - row.start > 4096) return null;
        rows.push(html.slice(row.start, index));
        if (rows.length > MAX_SOURCE_ROWS) return null;
        lastEnd = end;
        row = null;
      }
      if (list?.level === level) {
        remainder += html.slice(lastEnd, index);
        completed = true;
        list = null;
      }
      if (pageLevel === level) {
        if (completed) pageCompleted = true;
        pageLevel = null;
      }
      level -= 1;
      continue;
    }

    level += 1;
    const classes = (attribute(tag[0], 'class') || '').split(/\s+/);
    if (classes.includes('paginaComun')) pageLevel = level;
    if (pageLevel !== null && level > pageLevel && classes.includes('formulario')) {
      if (list || completed) return null;
      list = { level };
      lastEnd = end;
    } else if (list && level === list.level + 1 && classes.includes('evento')) {
      remainder += html.slice(lastEnd, index);
      row = { level, start: end };
    }
  }
  return completed && pageCompleted ? { rows, remainder } : null;
}

function parseRow(row) {
  const anchor = /(<a(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/a\s*>/gi;
  const anchors = [...row.matchAll(anchor)];
  if (anchors.length !== 1) return null;
  const [match] = anchors;
  const prefix = htmlToText(row.slice(0, match.index)).trim();
  const date = prefix.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+¡HOY!)?\s*\|$/i);
  if (!date || htmlToText(row.slice(match.index + match[0].length)).trim()) return null;

  const iso = dateIso(Number(date[3]), Number(date[2]), Number(date[1]));
  const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim();
  const url = eventUrl(attribute(match[1], 'href'));
  if (!iso || !title || title.length > 300 || /[\p{Cc}\p{Cf}<>]|https?:\/\/|\bwww\./iu.test(title) || !url) return null;
  return { date: iso, title, url };
}

/**
 * Read only the server-rendered FCE agenda. Invalid content must never be
 * treated as empty by a caller that retains the previous valid snapshot.
 */
export function parseAgendaHtml(html, { today } = {}) {
  const todayMatch = typeof today === 'string' && today.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!todayMatch || dateIso(...todayMatch.slice(1).map(Number)) !== today) {
    throw new RangeError('today must be a valid YYYY-MM-DD calendar date');
  }
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return fail('invalid_html');

  try {
    const document = html.replace(/<!--[\s\S]*?-->|<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const list = collectRows(document);
    if (!list) return fail('unrecognized_list');
    const { rows, remainder } = list;
    if (!rows.length) {
      if (remainder.trim().length > 256) return fail('unrecognized_list');
      const emptyMessage = htmlToText(remainder).trim();
      if (remainder.trim() && !/^No hay eventos(?: programados)?(?: en este momento)?\.?$/i.test(emptyMessage)) {
        return fail('unrecognized_list');
      }
      return { status: 'empty', events: [], total: 0 };
    }
    if (remainder.trim()) return fail('unrecognized_list');

    const parsed = rows.map(parseRow);
    if (parsed.some(event => !event)) return fail('invalid_row');
    const unique = new Map(parsed.map(event => [JSON.stringify(event), event]));
    const active = [...unique.values()].filter(event => event.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    return { status: active.length ? 'ok' : 'empty', events: active.slice(0, MAX_AGENDA_EVENTS), total: active.length };
  } catch (error) {
    if (error instanceof RangeError) return fail('invalid_row');
    throw error;
  }
}
