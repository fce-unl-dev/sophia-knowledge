// Documentos provisorios: quien sube un documento que todavía puede cambiar lo
// marca con "[PROVISORIO]" en el nombre del archivo, y la ingesta le agrega un
// aviso para que Luca advierta que no es definitivo. Caso que lo motivó: los
// regímenes de correlatividades 2027, con correlatividades aún sin definir
// (31/10/2026).
//
// La marca no forma parte del slug: al quitarla cuando el documento queda
// firme, se regenera el mismo archivo del KB, sin dejar uno viejo huérfano.

const TAG = /\s*\[\s*provisorio\s*\]\s*/gi;

export function isProvisional(file) {
  return new RegExp(TAG.source, 'i').test(String(file?.name ?? ''));
}

// Quita la marca de cada tramo de una ruta "carpeta/archivo.ext".
export function stripProvisionalTag(text) {
  return String(text).split('/')
    .map((part) => part.replace(TAG, ' ').replace(/\s+(\.[^./]+)$/, '$1').replace(/\s{2,}/g, ' ').trim())
    .join('/');
}

export const PROVISIONAL_NOTICE = '> **Documento provisorio.** Quien lo cargó indicó que todavía puede cambiar: algunos datos pueden no estar definidos o modificarse próximamente. Al responder con esta información, aclarar que es provisoria y sugerir confirmarla con el área que corresponda.';

// Inserta el aviso al comienzo de "## Contenido" (o después del título si no hay sección).
export function applyProvisionalNotice(markdown) {
  const md = String(markdown);
  if (md.includes(PROVISIONAL_NOTICE)) return md;
  if (/^## Contenido[ \t]*$/m.test(md)) return md.replace(/^## Contenido[ \t]*\n/m, (heading) => `${heading}\n${PROVISIONAL_NOTICE}\n`);
  return md.replace(/^(# [^\n]*\n)/m, `$1\n${PROVISIONAL_NOTICE}\n`);
}
