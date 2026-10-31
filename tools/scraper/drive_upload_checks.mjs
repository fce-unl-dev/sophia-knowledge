// Controles baratos sobre lo que se sube a Drive, antes de gastar una llamada
// al modelo. No bloquean la ingesta: generan avisos para quien subió el archivo,
// para que la próxima vez lo haga distinto (ver docs/GUIA_CARGA_DRIVE.md).

// Quién subió o modificó por última vez el archivo, según Drive.
export function uploaderOf(file) {
  const person = file?.lastModifyingUser?.emailAddress ? file.lastModifyingUser : file?.owners?.find((owner) => owner?.emailAddress);
  return person ? { name: person.displayName || person.emailAddress, email: person.emailAddress } : null;
}

export function fileSummary(file) {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink || null,
    uploader: uploaderOf(file),
  };
}

const GENERIC_NAME = /^(?:copia de |copy of )|^(?:documento|document|archivo|sin t[ií]tulo|untitled|nuevo|final|borrador)(?:[\s_-]*(?:final|nuevo|\d+))*(?:\s*\(\d+\))?(?:\.\w+)?$|\(\d+\)(?:\.\w+)?$/i;

const baseName = (name) => String(name).replace(/\.[^./]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const folderOf = (path) => (String(path).includes('/') ? String(path).slice(0, String(path).lastIndexOf('/')) : '');

// Avisos sobre el inventario completo de la carpeta.
export function checkUploadHygiene(files) {
  const warnings = [];
  const warn = (file, kind, advice) => warnings.push({ ...fileSummary(file), kind, advice });

  const byFolderAndName = new Map();
  for (const file of files) {
    const key = `${folderOf(file.path)}\u0000${baseName(file.name)}`;
    byFolderAndName.set(key, [...(byFolderAndName.get(key) || []), file]);
  }

  for (const file of files) {
    if (!folderOf(file.path)) {
      warn(file, 'carpeta-raiz', 'Está suelto en la carpeta principal. Movelo a la carpeta del tema (02-Grado, 04-Posgrado, etc.): la carpeta define en qué tema lo busca Luca.');
    }
    if (GENERIC_NAME.test(file.name)) {
      warn(file, 'nombre-generico', 'El nombre no dice de qué trata. Usá un nombre descriptivo, por ejemplo "Res. CS 481-26 Plan Contador Público 2027".');
    }
  }

  // Mismo nombre en la misma carpeta: casi siempre una versión nueva subida
  // como archivo aparte, y la vieja sigue vigente para Luca.
  for (const group of byFolderAndName.values()) {
    if (group.length < 2) continue;
    const [newest, ...older] = [...group].sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
    warn(newest, 'posible-duplicado', `Hay ${older.length + 1} archivos con este nombre en la misma carpeta. Si es una versión nueva, borrá la anterior; la próxima vez usá "Administrar versiones" → "Subir nueva versión" sobre el archivo original.`);
  }
  return warnings;
}

// Datos personales con señales fuertes. Los teléfonos y mails no cuentan: los
// documentos institucionales los traen legítimamente (áreas, secretarías).
const PERSONAL_DATA = [
  ['DNI', /\bD\.?N\.?I\.?\s*(?:N[º°o.]*\s*)?:?\s*\d{1,2}\.?\d{3}\.?\d{3}\b/i],
  ['CUIL/CUIT', /\b(?:20|23|24|27)-?\d{8}-?\d\b/],
  ['legajo', /\blegajo\s*(?:N[º°o.]*\s*)?:?\s*\d{4,}\b/i],
];

export function scanPersonalData(text) {
  return PERSONAL_DATA.filter(([, pattern]) => pattern.test(String(text ?? ''))).map(([label]) => label);
}

export function personalDataWarning(file, found) {
  return {
    ...fileSummary(file),
    kind: 'datos-personales',
    advice: `Parece incluir datos personales (${found.join(', ')}). Si son de una persona concreta, quitalos del documento: todo lo que entra a la base de Luca es público.`,
  };
}
