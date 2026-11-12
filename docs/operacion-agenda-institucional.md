# Operación de la agenda institucional

El flujo **Preview Institutional Agenda** genera a diario una vista previa de la agenda oficial de la FCE. El artefacto `institutional-agenda-preview` **no se publica**: Luca consulta el archivo `agenda/institucional.json` disponible en la revisión de KB que tiene configurada, no los artefactos de GitHub Actions.

1. Revise el resultado de la ejecución y descargue el artefacto. Compruebe la fecha de actualización, los enlaces oficiales y los cambios de altas y bajas. Una lista vacía válida reemplaza la anterior; un error de descarga o lectura hace fallar el flujo y no se genera artefacto.
2. Para publicar una actualización, proponga solo `agenda/institucional.json` mediante el proceso de revisión del repositorio. En local puede regenerar el mismo archivo con `node tools/scraper/build_agenda_snapshot.mjs` desde la raíz.
3. En TEST, confirme qué revisión de KB usa Luca y consulte por un evento vigente. Debe devolver la fecha y el enlace oficiales. Cuando la copia llegue a las 48 horas de antigüedad, debe indicar el enlace a la agenda oficial sin afirmar fechas.

La revisión y publicación manual requieren una persona responsable y suplente: una ejecución exitosa cada día **no garantiza** que la copia consumida por Luca tenga menos de 48 horas. Si la publicación se demora o el flujo falla, conserve la última versión revisada y verifique el enlace alternativo en TEST. El flujo no modifica ramas, no llama a LUX y conserva cada artefacto durante tres días.
