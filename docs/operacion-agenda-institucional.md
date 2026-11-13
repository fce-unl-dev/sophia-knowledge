# Operación de la agenda institucional

El flujo **Preview Institutional Agenda** se ejecuta a diario a las 07:17 (hora de Córdoba) para actualizar `agenda/institucional.json` desde la agenda oficial de la FCE mediante un Pull Request con validación determinística:

1. **Extracción y validación estricta:** ejecuta `node tools/scraper/build_agenda_snapshot.mjs`. Si la web oficial falla, redirige o devuelve HTML inválido, el flujo falla sin modificar `agenda/institucional.json` (se conserva la última copia válida publicada en `main`).
2. **Evaluación automática de anomalías (`evaluate_agenda_update.mjs`):**
   - **Auto-merge (`auto-update`):** si pasan las pruebas unitarias y las validaciones de índice/enlaces (`validate_index.mjs` y `validate_links.mjs`), y los cambios corresponden a altas, actualizaciones o vencimientos naturales de fechas pasadas, el PR (`kb-sync/agenda-institucional`) se mergea automáticamente a `main`.
   - **Revisión humana (`needs-review`):** si la agenda pasa repentinamente a 0 eventos cuando había eventos vigentes, si desaparecen 2 o más eventos con fecha futura antes de su realización, o si falla alguna validación, el PR **no** se auto-mergea y queda abierto para revisión humana.
3. **Resguardo ante fallos:** la copia publicada en `main` tiene una vigencia de 48 horas en Luca. Al refrescarse cada 24 horas, un fallo puntual de un día deja un margen de 24 horas para revisar o re-ejecutar el workflow manualmente. Pasadas las 48 horas sin refresco válido, Luca deja de afirmar fechas y deriva al enlace oficial de la agenda.
