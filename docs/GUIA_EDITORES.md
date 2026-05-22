# Guía de Operación y Redacción para Editores de la FCE-UNL

Esta guía fue diseñada especialmente para coordinadores, administrativos y directores de áreas de la Facultad de Ciencias Económicas que tienen la responsabilidad de mantener actualizada la información de **Sophia** (asistente virtual).

Aquí aprenderás a editar los archivos de contenido sin necesidad de tener conocimientos previos de programación, entendiendo la tecnología a través de analogías sencillas de la administración pública y universitaria.

---

## 🔍 Glosario de Equivalencias Tecnológicas

Para colaborar con el equipo técnico de desarrollo, a veces escucharás términos extraños. A continuación te explicamos qué significan usando equivalencias de la vida administrativa de la facultad:

| Término Técnico | Equivalente Administrativo | ¿Qué significa en la práctica? |
|---|---|---|
| **Repositorio (Repo)** | **Mesa de Entradas Digital / Archivo General** | Es la carpeta centralizada en la nube donde se guardan de manera ordenada todos los archivos de texto que consume Sophia. |
| **Commit** | **Firmar y Guardar en Borrador** | Es la acción de guardar tus modificaciones en un archivo. Cada commit genera un registro permanente de quién hizo el cambio y a qué hora. |
| **Rama (Branch)** | **Copia de Expediente para Trabajo** | Es una sección separada del archivo para que hagas tus cambios sin modificar el original que está leyendo Sophia en producción. |
| **Pull Request (PR)** | **Nota de Elevación / Proyecto de Resolución** | Es una solicitud formal donde le dices al administrador del sistema: *"Hice estos cambios en mi copia de expediente, por favor revísenlos y autoricen su incorporación al archivo definitivo"*. |
| **Merge** | **Firma del Decano / Homologación** | Es el acto de aprobar y fusionar tu propuesta de cambio dentro del archivo definitivo (`main`). Una vez que se hace el merge, el cambio pasa a estar vigente. |
| **Deploy** | **Publicación en el Boletín Oficial** | Es el proceso automático que toma los archivos del repositorio oficial y los pone a disposición de Sophia en la web y en WhatsApp. |
| **Markdown (.md)** | **Texto con Formato Simple** | Es el formato de los archivos del repositorio. Permite escribir textos comunes pero agregando marcas simples (como asteriscos para las negritas o guiones para listas) para que se vean bien en el chat. |
| **JSON (como `indice.json`)** | **Índice Temático o Catálogo** | Un tipo de archivo especial que funciona como el índice de un libro. Le indica a Sophia exactamente qué archivos del repositorio debe leer y cuáles ignorar. |
| **RAG (Recuperación Vectorial)** | **Buscar en la biblioteca por palabras clave** | Una tecnología antigua donde el robot buscaba pedacitos de textos en una base de datos gigante. En su lugar, ahora usamos **Inyección en Contexto**, que equivale a **entregarle a Sophia la carpeta con todos los textos oficiales organizados en la mano** cada vez que empieza a hablar, evitando que delire o invente información. |

---

## 🔄 Flujo de Trabajo: Cómo proponer un cambio

El mantenimiento de la información se hace a través de la plataforma GitHub. Podés realizar cambios menores (como corregir una fecha o un contacto) directamente desde tu navegador web siguiendo estos pasos:

### Paso 1: Encontrar el archivo a modificar
1. Navega por las carpetas del repositorio según el área correspondiente:
   - `/posgrados/` si vas a cambiar información de maestrías o especializaciones.
   - `/cursos/` si es un curso de formación profesional.
   - `/estudiantes/` si es un trámite de bedelía de grado o calendario académico.
2. Haz clic sobre el archivo que querés modificar (por ejemplo, `tributacion.md`).

### Paso 2: Editar el archivo
1. Haz clic en el ícono del **Lápiz** (Editar este archivo) en la esquina superior derecha.
2. Realiza las modificaciones en el texto de acuerdo con las **Reglas de Redacción** (ver sección siguiente).

### Paso 3: Guardar el borrador y proponer el cambio (Commit y PR)
1. Al finalizar las ediciones, desplázate hasta la parte inferior donde dice **"Commit changes..."** (Guardar cambios).
2. Completa los campos:
   - **Título corto**: Escribe qué cambiaste (ej. *Actualización de fecha de inicio Maestría en Administración*).
   - **Descripción**: Detalla por qué se hizo el cambio y cuál fue la fuente (ej. *Se cambió el inicio al 15 de mayo según Resolución Decana 123/26*).
3. Selecciona la opción **"Create a new branch for this commit and start a pull request"** (Crear una nueva rama y proponer el cambio). Esto asegura que no alteres lo que los usuarios están leyendo en vivo hasta que alguien lo revise.
4. Haz clic en **"Propose changes"** o **"Commit changes"**.

### Paso 4: Elevar para revisión técnica
1. En la pantalla que aparece, haz clic en el botón verde **"Create pull request"** (Crear solicitud de revisión).
2. Esto notificará a los administradores técnicos de la facultad para que verifiquen la estructura. Una vez aprobado, ellos realizarán el **Merge** y la información impactará en Sophia de forma automática.

---

## ✍️ Reglas de Redacción de Contenidos

Para asegurar que Sophia interprete correctamente la información y no confunda a los alumnos, debés seguir estas pautas al escribir:

### 1. Respetar la plantilla oficial (`template.md`)
Cada carrera o programa debe seguir la misma estructura. Si das de alta un programa nuevo, copia el contenido de [template.md](template.md) y rellena los campos correspondientes. Esto ayuda a que el robot localice de manera predecible datos clave como contactos, aranceles o directores.

### 2. Formato de texto (Markdown básico para WhatsApp)
En WhatsApp, el formato complejo se rompe. Sigue estas reglas de estilo:
- **Negritas**: Enmarca el texto clave entre doble asterisco (ej. `**CPN**` o `**15 de mayo**`). Úsalo para destacar nombres de carreras, fechas límites, montos de inscripción y números de teléfono.
- **Listas**: Usa guiones medios (`-`) para hacer viñetas. Son mucho más legibles que los bloques de texto largos.
- **Enlaces**: Escribe el texto visible entre corchetes y la dirección web entre paréntesis (ej. `[Página de Inscripción](https://www.fce.unl.edu.ar/inscripciones)`). Evita pegar enlaces largos y feos.
- > [!WARNING]
  > **No uses títulos Markdown con `#`**: Los títulos como `# Título` o `## Subtítulo` se ven con los numerales literalmente en la pantalla de WhatsApp. En su lugar, escribe una línea corta en negrita y pon un espacio abajo (ej. `**Requisitos de ingreso:**`).

### 3. Cuidado extremo con las fechas (Razonamiento Temporal)
Sophia calcula qué día es hoy antes de responder. Si un texto dice *"Las inscripciones abren el 5 de marzo"* y hoy es 10 de marzo, Sophia sabrá que esa fecha ya pasó y le dirá al usuario que las inscripciones cerraron.
- **Sé explícito con el año**: Escribe siempre el año completo (ej. `15 de diciembre de 2026`). Si ponés solo "diciembre", el robot podría asumir que es del año en curso o del próximo de forma ambigua.
- **Marca de "Ya pasó" o "A confirmar"**: Si una fecha es del año pasado y aún no se definió la nueva, indícalo expresamente: `Próxima fecha: a confirmar por secretaría para el ciclo 2026/2027`.

### 4. Evitar duplicar información (Un único archivo por curso)
- Para los cursos de formación profesional, se debe tener **exactamente un archivo Markdown por curso** en la carpeta `/cursos/`.
- No crees un archivo general que diga *"Cursos del mes"* porque duplicará las fechas y costos que ya están en los archivos individuales. Si cambias un costo en un lado y te olvidas del otro, Sophia dará respuestas contradictorias.

### 5. Declarar fuentes al final de cada documento
Cada archivo de contenido debe cerrar con una sección de respaldo documental estructurada así:

```markdown
**Fuentes y Control:**
- **Fuentes oficiales**: [Web FCE - Maestría en Administración](https://www.fce.unl.edu.ar/mba) / Documento de aranceles Drive corporativo.
- **Última revisión humana**: 22 de mayo de 2026.
- **Responsable de revisión**: Coordinación de Posgrado (Nombre del Responsable).
```

Esto garantiza que ante cualquier duda o conflicto entre versiones, el equipo de desarrollo pueda verificar de dónde provienen los datos.
