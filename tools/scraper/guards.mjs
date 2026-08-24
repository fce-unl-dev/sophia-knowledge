// Guardas compartidas de los pipelines del KB de Sophia.
//
// Todas responden lo mismo: `null` si está todo bien, o un objeto con `status`
// y un `reason` escrito para que lo lea un operador, si hay que cortar. El que
// llama decide qué hacer con eso, pero ninguna guarda ablanda: si dispara, se
// corta antes de gastar una llamada al modelo o de borrar contenido del KB.
//
// Hay tres:
//
//   checkRawFloor        el scrape trajo menos texto útil que el mínimo
//   checkRawRegression   el scrape encogió respecto de la corrida anterior
//   checkRemovalRatio    las bajas se comen un porcentaje del inventario y no
//                        hay altas que las compensen

// Piso de contenido útil para fichas web generadas desde una plantilla. Con la
// plantilla en el prompt y un scrape vacío, el modelo completa con su
// conocimiento previo en vez de con la fuente.
export const DEFAULT_MIN_RAW_CHARS = 600;

// Los documentos sueltos (PDFs, formularios de una carilla) son legítimamente
// más cortos que una ficha de carrera: piso propio, más bajo.
export const DEFAULT_MIN_DOC_CHARS = 200;

// Si el scrape quedó por debajo de este porcentaje del de la corrida anterior,
// casi siempre la página cambió de estructura y el extractor dejó de matchear.
export const RAW_REGRESSION_RATIO = 0.4;

// Porcentaje del inventario que las bajas netas no pueden superar. Calibrado
// contra tres casos reales del repo:
//
//   Drive 24/08:        13 bajas / 31 documentos = 42%, 0 altas  → corta
//   Cursos formación:    3 bajas / 16 fichas     = 19%, 0 altas  → pasa
//   Cursos posgrado:     2 bajas / 8 fichas      = 25%, 4 altas  → pasa (netas < 0)
export const DEFAULT_MAX_REMOVAL_RATIO = 0.3;

// Debajo de esto, el porcentaje es puro ruido: en un inventario de 3, una sola
// baja ya es 33%. Se exige además un mínimo absoluto de bajas netas.
export const DEFAULT_MIN_NET_REMOVALS = 2;

// Mide el contenido efectivamente aprovechable de un scrape: descarta líneas en
// blanco y colapsa espacios repetidos antes de contar. Un raw.txt de 3 KB de
// saltos de línea y sangrías no es un scrape útil.
export function usefulTextLength(text) {
  if (!text) return 0;
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .length;
}

// Piso absoluto de texto útil.
export function checkRawFloor(rawText, { minRawChars = DEFAULT_MIN_RAW_CHARS, label = 'esta fuente', hint = '' } = {}) {
  const rawLength = usefulTextLength(rawText);
  if (rawLength >= minRawChars) return null;
  const tail = hint || 'Revisá si la página cambió de estructura o si la estrategia de extracción dejó de servir para esta URL.';
  return {
    status: 'insufficient-raw',
    reason: `el scrape de ${label} trajo ${rawLength} caracteres útiles, por debajo del mínimo de ${minRawChars}. No se generó contenido: con tan poco texto el modelo lo completaría inventando. ${tail}`,
    raw_length: rawLength,
    min_raw_chars: minRawChars,
  };
}

// Regresión contra el tamaño de la corrida anterior. Un tamaño previo ausente,
// cero o no numérico significa que no hay con qué comparar, no que haya error.
export function checkRawRegression(rawLength, previousRawLength, { ratio = RAW_REGRESSION_RATIO, label = 'esta fuente' } = {}) {
  if (!Number.isFinite(previousRawLength) || previousRawLength <= 0) return null;
  if (rawLength / previousRawLength >= ratio) return null;
  const pct = Math.round((rawLength / previousRawLength) * 100);
  return {
    status: 'raw-regression',
    reason: `el scrape de ${label} trajo ${rawLength} caracteres útiles contra ${previousRawLength} de la corrida anterior: ${pct}% del tamaño previo, cuando el mínimo tolerado es ${Math.round(ratio * 100)}%. No se generó contenido: una caída así casi siempre significa que la página cambió de estructura y el extractor dejó de encontrarlo. Revisá la URL a mano antes de volver a correr.`,
    raw_length: rawLength,
    previous_raw_length: previousRawLength,
  };
}

// Bajas masivas. `inventory` es lo que había antes de esta corrida, `removals`
// lo que desapareció de la fuente y `additions` lo que llegó nuevo.
//
// Un pipeline que borra la mitad de una carpeta de un saque casi nunca está
// reflejando una baja real: está mirando una fuente degradada. Y si además no
// trajo nada nuevo, no hay ninguna señal de que la fuente esté sana.
export function checkRemovalRatio({
  inventory = 0,
  removals = 0,
  additions = 0,
  maxRemovalRatio = DEFAULT_MAX_REMOVAL_RATIO,
  minNetRemovals = DEFAULT_MIN_NET_REMOVALS,
  label = 'este pipeline',
} = {}) {
  if (inventory <= 0 || removals <= 0) return null;

  const netRemovals = Math.max(0, removals - additions);
  if (netRemovals <= 0) return null;

  const ratio = netRemovals / inventory;
  const wipesEverything = removals >= inventory;
  if (!wipesEverything && (netRemovals < minNetRemovals || ratio <= maxRemovalRatio)) return null;

  const pct = Math.round(ratio * 100);
  const compensacion = additions > 0
    ? `${additions} alta${additions === 1 ? '' : 's'} no alcanzan a compensarlas`
    : 'sin ninguna alta que las compense';
  const detalle = wipesEverything
    ? `Desaparecería el inventario entero de ${label}.`
    : `Es el ${pct}% del inventario de ${label} (${inventory}), ${compensacion}.`;

  return {
    status: 'removal-anomaly',
    reason: `${removals} baja${removals === 1 ? '' : 's'} en una sola corrida. ${detalle} No se borra nada: una caída así casi siempre es una fuente degradada — una carpeta que dejó de listarse, un permiso revocado, un listado que cambió de estructura — y no una baja real. Verificá la fuente a mano antes de aplicar estos borrados.`,
    inventory,
    removals,
    additions,
    net_removals: netRemovals,
    removal_ratio: Number(ratio.toFixed(4)),
    max_removal_ratio: maxRemovalRatio,
  };
}

// Un candidato que pisa una ficha existente y viene mucho más chico es la misma
// degradación que checkRawRegression, vista un paso más adelante: el crawl
// quedó corto y el pipeline está por reemplazar contenido curado por un
// esqueleto. Se mide sobre texto útil, no sobre bytes.
export function checkContentRegression(candidateText, previousText, { ratio = RAW_REGRESSION_RATIO, label = 'esta ficha' } = {}) {
  const previousLength = usefulTextLength(previousText);
  if (previousLength <= 0) return null;
  const candidateLength = usefulTextLength(candidateText);
  if (candidateLength / previousLength >= ratio) return null;
  const pct = Math.round((candidateLength / previousLength) * 100);
  return {
    status: 'content-regression',
    reason: `el candidato para ${label} tiene ${candidateLength} caracteres útiles contra ${previousLength} de la ficha que reemplazaría: ${pct}% del tamaño actual, cuando el mínimo tolerado es ${Math.round(ratio * 100)}%. No se sobrescribe: perder ese volumen de contenido curado casi siempre significa que la fuente vino incompleta.`,
    candidate_length: candidateLength,
    previous_length: previousLength,
  };
}
