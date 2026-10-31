# Cómo subir documentos a la carpeta de Drive de Luca

Esta guía es para quienes cargan documentos en la carpeta de Google Drive que alimenta a Luca. No hace falta saber programar.

Una copia de este texto está en la misma carpeta de Drive como **"LEEME (NO_INDEXAR) – Cómo subir documentos"**. El `NO_INDEXAR` del nombre evita que la guía entre a Luca como si fuera un documento más.

## Qué pasa con lo que subís

1. **Una vez por día**, normalmente entre las 10 y las 13 (hora de Argentina), un proceso revisa la carpeta y detecta archivos nuevos o modificados. Está programado para las 06:00, pero GitHub suele demorarlo algunas horas.
2. Los transcribe, los ordena y propone incorporarlos a la base de Luca en una **revisión** (un pull request en GitHub).
3. Una persona revisa el contenido y lo aprueba. Recién ahí Luca empieza a usarlo, en menos de una hora.
4. Si un archivo no se pudo procesar, **no entra incompleto**: aparece en el issue [**Drive: documentos no procesados**](https://github.com/fce-unl-dev/sophia-knowledge/issues?q=is%3Aissue+is%3Aopen+label%3Adrive-no-procesados) con el motivo y qué hacer. Se reintenta solo en la corrida siguiente.
5. **Te avisamos por mail.** Si un documento que subiste tuvo un problema, te llega un correo con qué pasó y qué hacer; y otro cuando quedó resuelto. También avisa si el archivo está suelto en la carpeta principal, tiene un nombre genérico, parece duplicado o incluye datos personales.

## Formatos

| Formato | ¿Funciona? | Comentario |
|---|---|---|
| Documento de Google | ✅ El mejor | Se lee sin pérdidas. |
| Hoja de cálculo de Google | ✅ El mejor para tablas | Las celdas se copian exactas, sin interpretación. |
| Excel `.xlsx` | ✅ | Igual de exacto que una Hoja de Google. Las hojas ocultas no se publican. |
| PDF con texto seleccionable | ✅ | Si podés seleccionar el texto con el mouse, se lee bien. |
| Word `.docx` | ✅ | Las tablas complejas pueden perder formato: si la tabla es lo importante, subila como Hoja de cálculo. |
| PowerPoint `.pptx` y Presentaciones de Google | ✅ | Se toma el texto de cada diapositiva; las imágenes de las diapositivas no. |
| Imágenes PNG, JPG o WebP | ⚠️ | Se leen con IA. Sirven para un afiche o una tabla corta; para documentos largos, mejor PDF o Documento de Google. |
| PDF escaneado (foto de un papel) | ⚠️ | Se lee con IA y puede tener errores. Si existe la versión digital, subí esa. |
| Excel viejo `.xls`, Word viejo `.doc` | ❌ / ⚠️ | Abrilos y guardalos como Hoja de cálculo o Documento de Google. |

## Reglas para que todo funcione

1. **Un documento por tema.** No juntes la resolución de un plan con su cronograma en el mismo archivo.
2. **Tablas importantes como Hoja de cálculo.** Correlatividades, aranceles, horarios o listados de materias quedan exactos como planilla. En PDF o Word dependen de una transcripción.
3. **Para actualizar un documento, reemplazá el archivo, no subas otro.** En Drive: clic derecho → *Información del archivo* → *Administrar versiones* → *Subir nueva versión*. Así Luca reemplaza la versión vieja. Si subís un archivo nuevo con el mismo nombre, quedan dos y el viejo sigue vigente hasta que lo borres.
4. **Si cambiás el formato, borrá el anterior.** Por ejemplo, si convertís un Excel a Hoja de cálculo de Google, eliminá el `.xlsx` original.
5. **Nombres descriptivos.** "Res. CS 481-26 Plan Contador Público 2027" ayuda; "documento final (2)" no.
6. **Usá la carpeta que corresponde al tema** (`02-Grado`, `04-Posgrado`, `06-Reglamentos y normas`, etc.). La carpeta define en qué tema lo busca Luca.
7. **Nada de datos personales.** No subas listados de estudiantes, DNI, teléfonos o mails personales: todo lo que entra a la base de Luca queda publicado. Los datos institucionales (autoridades, mails de áreas) sí.
8. **Borradores en una carpeta `NO_INDEXAR`.** Todo lo que tenga `NO_INDEXAR` en el nombre del archivo o de la carpeta se ignora.
9. **Si todavía puede cambiar, marcalo `[PROVISORIO]`.** Agregá `[PROVISORIO]` al nombre del archivo, por ejemplo "[PROVISORIO] LA 484 Correlatividades 2027". Luca va a advertir que la información no es definitiva. Cuando quede firme, quitá la marca del nombre (o subí la versión definitiva con *Administrar versiones*) y el aviso desaparece solo.

## Si algo no aparece en Luca

- Revisá el issue **Drive: documentos no procesados**: ahí figura cada archivo pendiente con qué hacer.
- Si no está ahí, puede estar esperando revisión: buscá el pull request abierto **"KB sync: complementos de Drive"**.
- Si tampoco está, avisá al responsable técnico con el nombre exacto del archivo.
