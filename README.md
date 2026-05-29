# Sophia — Base de Conocimiento (FCE-UNL)

Este repositorio contiene la **base de conocimiento oficial** de **Sophia**, la asistente virtual de la Facultad de Ciencias Económicas de la Universidad Nacional del Litoral (FCE-UNL).

Aquí reside la **única fuente de verdad** que Sophia consulta en tiempo real para responder a los usuarios por chat web y WhatsApp. Cada archivo aquí guardado ha sido redactado, verificado y aprobado por personas de la institución.

---

## 📖 Sección 1: Para Editores y Personal de la Facultad (No Técnicos)

Si sos coordinador, administrativo o responsable de un área en la FCE y necesitás actualizar la información que Sophia utiliza para responder (por ejemplo, corregir la fecha de un trámite, agregar un nuevo curso o cambiar un número de contacto), esta sección es para vos.

### ¿Cómo funciona la base de conocimiento?
A diferencia de otros sistemas que leen directamente la web (lo que a veces genera que Sophia responda con información vieja o confusa de años anteriores), Sophia lee **exclusivamente** los archivos de este repositorio. Si la información no está escrita aquí de forma clara, Sophia dirá honestamente que no la sabe y derivará la consulta a un operador humano.

### ¿Cómo actualizar la información?
El proceso de actualización sigue un flujo de control de calidad institucional simple:
1. **Propuesta de Cambio**: Creás una propuesta con el cambio (por ejemplo, editando un archivo de texto directamente en la web de GitHub o solicitando la modificación desde el panel administrativo de Sophia).
2. **Revisión**: El equipo técnico o el administrador del sistema revisa que el archivo esté bien formateado y que no rompa las reglas de Sophia.
3. **Aprobación y Publicación**: Se aprueba la propuesta y los cambios se guardan en el sistema.
4. **Publicación en Producción**: Sophia descarga la información actualizada y comienza a usarla para responder en su próximo ciclo de actualización automática (o inmediatamente si se fuerza la actualización desde el panel).

### Guía Completa de Edición
Para ver el paso a paso detallado, cómo dar de alta nuevos cursos, cómo usar plantillas y explicaciones sencillas de todos los términos, consulta la:
👉 **[Guía de Operación y Redacción para Editores](docs/GUIA_EDITORES.md)**

---

## 🛠️ Sección 2: Para Desarrolladores y Colaboradores Técnicos (Technical Reference)

Esta sección describe la arquitectura de la base de conocimiento, su integración con el agente y los mecanismos de validación automatizados.

### Consumo en Runtime
El agente de producción (arquitectura consolidada: KB completa inyectada en el contexto del modelo, sin RAG) consume este repositorio de manera dinámica:
1. Al iniciar o expirar el TTL de la caché, el agente descarga [indice.json](indice.json).
2. El archivo `indice.json` actúa como el manifiesto de la base de conocimiento, mapeando los archivos Markdown (`.md`) permitidos, sus categorías y descripciones.
3. El agente realiza peticiones HTTP a `raw.githubusercontent.com` para descargar cada uno de los archivos declarados en el índice.
4. Los archivos se concatenan y se inyectan en el contexto del LLM (Gemini) en la sección `BASE DE CONOCIMIENTO`.

### Estructura de Directorios

```
├── README.md               # Este archivo de bienvenida y referencia rápida.
├── indice.json             # Manifiesto/Índice dinámico de archivos consumidos por Sophia.
├── routing_metadata.json   # Reglas de enrutamiento y derivación a operadores humanos.
├── template.md             # Plantilla canónica que deben seguir los documentos académicos.
├── freshness.md            # Registro de frescura y última revisión humana general.
├── docs/                   # Documentación operativa de automatización e inventarios.
│   ├── GUIA_EDITORES.md    # Guía detallada para usuarios no técnicos de la FCE.
│   └── automation/         # Contratos y explicaciones de los pipelines de scraping.
├── posgrados/              # Carreras de posgrado de la FCE (maestrías, especializaciones, etc.).
├── diplomaturas/           # Diplomaturas universitarias de la FCE.
├── compartidos/            # Posgrados compartidos con otras facultades.
├── cursos/                 # Cursos de formación profesional (1 archivo .md por curso).
├── estudiantes/            # Información de bedelía, trámites y vida estudiantil de grado.
├── operativos/             # Aulas virtuales, régimen de enseñanza y datos generales.
├── posgrado-general/       # Guías y normativas transversales de posgrado.
└── tools/                  # Scripts y herramientas de automatización de soporte.
    └── scraper/            # Pipeline de scraping y detección automática de diferencias.
```

### Reglas Críticas del Repositorio

- **Cursos de Formación Profesional**: Debe mantenerse estrictamente **un archivo Markdown por curso** dentro de la carpeta `cursos/`. No se deben crear resúmenes agrupados (como `cursos-activos.md`), ya que provocan redundancia y contradicciones en el contexto del LLM.
- **Declaración de Fuentes**: Al final de cada archivo Markdown se deben declarar obligatoriamente las fuentes oficiales (enlaces web oficiales de la FCE o carpetas de Drive institucionales), la fecha de la última revisión humana y el responsable de la revisión.
- **Formato Estricto**: Todos los nombres de archivos deben ser en minúsculas, separados por guiones medios (ej. `maestria-en-administracion.md`). No se deben usar caracteres especiales ni espacios.

### Automatización y Pipelines Seguro
Las herramientas en `tools/scraper/` automatizan la detección de cambios en el sitio oficial de la FCE y en planillas de Drive, y pueden proponer cambios automáticamente abriendo Pull Requests (PRs).
- **Merge Humano Obligatorio**: Ningún pipeline tiene permitido realizar merge automático ni escribir directamente a la rama `main`.
- **Datos Sensibles**: Cualquier cambio en fechas de inscripción, cuotas, aranceles, contactos o requisitos se clasifica como de alto riesgo y se marca en el PR requiriendo revisión humana explícita.
- Para más información sobre el comportamiento del pipeline, ver [docs/automation/pipeline-contract.md](docs/automation/pipeline-contract.md).
