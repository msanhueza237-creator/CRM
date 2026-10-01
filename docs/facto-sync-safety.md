# Consolidación manual Facto: protección de ejecución

Preparado localmente el 1 de octubre de 2026. No aplicado a una base de datos real ni desplegado.

## Alcance

Esta corrección cubre `syncFacto` en `accounting-center`: consolida el espejo `integration_records/facto` hacia Finanzas. No sustituye al conector que obtiene los datos desde Facto, no cambia su frecuencia y no corresponde a FACTO–Tiendanube. Un resultado `completed` acredita la consolidación del espejo disponible, no la frescura de Facto en producción.

## Comportamiento

- Una reserva atómica por empresa impide dos consolidaciones manuales simultáneas. Los bloqueos de base de datos y un token privado impiden nuevas escrituras de una ejecución reemplazada.
- Heartbeat cada 30 segundos, reserva de 3 minutos, límite de 30 segundos por solicitud REST (incluido el cuerpo) y 10 minutos por ejecución. Perder el heartbeat interrumpe el trabajo. No hay reintento automático de escrituras.
- Al siguiente intento autorizado, una reserva vencida cierra la ejecución anterior como fallida antes de crear otra. La interfaz muestra la interrupción aun antes de ese intento. No se inicia una sincronización al consultar el historial.
- Se informa un cierre no confirmado si la base de datos no responde. Los lotes anteriores pueden haberse guardado: no se promete rollback de toda la ejecución.
- Documentos contabilizados, anulados u otros estados no editables se omiten y se conservan. Un trigger protege también el cambio de estado ocurrido entre lectura y escritura; versiones anteriores del documento no reemplazan una versión más reciente. La omisión queda en el respaldo y en los contadores como observación.
- El historial diferencia cancelación, ejecución activa, reserva vencida y ejecución antigua sin actividad confirmada.

Las ejecuciones antiguas sin reserva no se cancelan por edad. Bloquean un nuevo intento hasta comprobar y resolver su estado con autorización: podrían proceder de un servidor todavía activo.

## Archivos y requisitos antes de publicar

`supabase/accounting_facto_sync_safety.sql` es SQL revisable, siguiendo la estructura actual de scripts del repositorio. Depende de `accounting_center.sql` y `accounting_facto_history.sql`. Su instalación no altera importes ni cancela ejecuciones históricas. Se probó su reaplicación en una base sintética.

La CLI de Supabase no está disponible en este entorno; no se instaló software ni se generó un registro de migración con CLI. Si el procedimiento de publicación exige migraciones versionadas, generar el contenedor con `supabase migration new` y trasladar el SQL antes de publicar. Los advisors y la compatibilidad con la versión desplegada de PostgREST quedan pendientes de un entorno de pruebas autorizado.

Antes de desplegar: coordinar SQL, función Edge y frontend. La prueba de concurrencia con dos conexiones PostgreSQL reales ya pasó en el entorno local desechable descrito en `facto-postgres-concurrency.md`. Retirar las instancias antiguas de la función antes de admitir nuevas ejecuciones. Los servidores anteriores no envían las cabeceras de reserva y no quedan protegidos por este protocolo. No aplicar solo el backend nuevo sin el SQL requerido.

La tabla de reservas y los RPC están restringidos a `service_role`; sus tokens no se devuelven al frontend. Las cabeceras internas se aplican exclusivamente a esta consolidación. El resto de las operaciones conserva su comportamiento.

## Validación realizada

Ejecutar: `node --experimental-strip-types scripts/test-facto-sync-safety.mjs`.

Pruebas aprobadas sobre PGlite en memoria y dependencias sintéticas: reserva exclusiva, heartbeat, vencimiento y recuperación, rechazo de token/ejecución antiguos, cancelación, bloqueo de ejecución heredada, permisos, conservación de contabilizados/anulados, cambio de estado concurrente simulado, actualización obsoleta, timeout de cabeceras/cuerpo, límite total, pérdida de heartbeat, fallo y cierre no confirmado, cierre exitoso después de auditoría, omisiones registradas y conflictos sin escrituras. PGlite serializa solicitudes; esto no sustituye una prueba de contención entre dos conexiones PostgreSQL.

Compilación verificada directamente contra fuentes, configuración Vite y dependencias del repositorio real: `tsc -b` y Vite build aprobados, con aviso de tamaño de bundles. Vite usó únicamente dos ajustes de validación: `envDir` vacío para no cargar `.env.local` y salida en el espacio de trabajo de Codex. No se copió el código para esta comprobación. Sus nueve assets coinciden byte a byte con la compilación integrada anterior; `index.html` coincide salvo finales de línea. `npm run typecheck:copilot` también pasó en el repositorio real.

Se corrigieron exclusivamente los dos `no-explicit-any` nuevos de `invoice-customer-classification.ts`, usando `Record<string, unknown>` y el tipo oficial `SupabaseClient` importado como tipo de la misma URL/version que usa `crm-agent`. No se modificó el comportamiento de clasificación. El lint de ese archivo pasa; el lint de `src`, `supabase`, `services` y `scripts` conserva 14 errores y 14 advertencias anteriores. La comprobación estricta adicional usa las declaraciones del paquete Supabase instalado, sin descargar ni ejecutar módulos remotos; no constituye un chequeo Deno de producción.

`npm run test:accounting` aprobado. Se corrigió el caso cuyo vencimiento fijo de septiembre hacía que cambiara de `pending` a `overdue` con el calendario. Ahora el escenario pendiente usa `CURRENT_DATE + 30` de la misma base sintética; no se modificó el cálculo de estados del CRM.

La batería integrada de rentabilidad, empresas, descuentos/XML, costos, revisión contable, Gemini y Realtime pasó 187 pruebas, sin fallos ni omisiones, ejecutadas directamente desde el repositorio real. La prueba contable y `test-facto-sync-safety.mjs` también pasaron allí. Se usaron datos/dependencias sintéticas y PGlite en memoria, sin servicios externos.

Se resolvió la diferencia de dependencias siguiendo `npm install`, documentado por README, con `--offline --ignore-scripts --no-audit --no-fund`. Primero se verificó el dry-run. npm agregó exactamente ocho paquetes desde caché: `fast-xml-parser@5.11.2`, `@nodable/entities@3.1.0`, `fast-xml-builder@1.3.1`, `path-expression-matcher@1.6.2`, `xml-naming@0.3.0`, `is-unsafe@2.0.2`, `strnum@2.4.2` y `anynum@1.0.1`. Las ocho versiones coinciden con el lockfile. No se actualizó ni eliminó otro paquete; `package.json` y `package-lock.json` conservan sus hashes previos a la instalación.

Chrome local verificó el componente real de revisión de asiento, con API simulada y solicitudes externas bloqueadas: previsualización, confirmación explícita, recuperación de errores y anchos 1280/390/320. No equivale a verificar una sesión autenticada de producción.

## Integración remota

La referencia remota fue actualizada y confirmó 16 commits entre `6d2f5bc` y `eeebbcc`. La integración conserva el trabajo local de Facto y Realtime. Se resolvieron conflictos en `.env.example` (solo plantilla), `crm-copilot/index.ts` (rutas nuevas) y `crm-copilot/live.ts` (convivencia de Gemini y Realtime). Doce archivos locales ya coincidían con sus versiones remotas; no se descartaron como trabajo ajeno.

Se conservaron copias y hashes previos en el espacio de trabajo de Codex. La integración avanza a commits remotos existentes mediante fast-forward, sin crear un commit nuevo ni publicar.

Marco autorizó después preparar PostgreSQL local. El 1 de octubre de 2026 se verificaron seis escenarios de concurrencia sobre PostgreSQL 17.11 con procesos backend distintos, datos sintéticos y el SQL real del repositorio. Pasaron exclusión, espera de heartbeat, orden de bloqueos con claves foráneas, pérdida de conexión/rollback, recuperación de reserva vencida, bloqueo del trabajador reemplazado y conservación de documentos contabilizados. Se adelantó únicamente el vencimiento de la reserva sintética para no esperar tres minutos.

Se utilizó el archivo de binarios EDB enlazado por PostgreSQL.org, sin pgAdmin, StackBuilder, servicio Windows ni reglas de firewall. SSPI autenticó al usuario Windows existente, sin crear contraseñas. El servidor escuchó solo en `127.0.0.1:65439` y quedó detenido, sin puerto en escucha. La base y los resultados se conservaron. No se abrió `.env.local` ni se reutilizaron credenciales productivas. Detalles, límites y reproducción en `facto-postgres-concurrency.md`; script en `scripts/test-facto-sync-concurrency.mjs`.

No se ejecutaron sincronizaciones reales, consultas financieras de producción, migraciones remotas, commits, push ni despliegues. La última ejecución real, errores actuales y estado del disco del VPS siguen sin verificarse con acceso autenticado.

## Revisión de frescura e interfaz — 1 de octubre de 2026

Los tres hallazgos posteriores (indicador de frescura, errores silenciosos del refresco e historial móvil) tienen correcciones locales autorizadas y pruebas sintéticas en [facto-freshness-review.md](facto-freshness-review.md). Continúan sin publicarse; no se comprobó por ello el estado vivo de producción.
