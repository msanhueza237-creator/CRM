# Correcciones de frescura y lectura financiera

Preparado localmente el 1 de octubre de 2026 por autorización expresa de Marco. Sin publicación, sincronizaciones reales ni SQL productivo.

## Cambios

- `facto-freshness.ts` calcula un estado conservador. Se separan lectura del conector, último intento y última consolidación completada. Fallo, cancelación, parcial y en curso tienen estados propios; ausencia de datos, conexión desconocida, fechas inválidas/futuras y respuestas de backend antiguo nunca aparecen como éxito.
- La última consolidación exitosa se consulta con filtro `status=completed`, fuera del límite de 24 intentos del historial. Se conserva aunque existan fallos posteriores. Una lectura posterior al inicio de esa ejecución queda pendiente, incluso si llegó antes de su cierre.
- El umbral preventivo de lectura antigua es 24 horas; no representa una frecuencia garantizada del conector. El éxito describe el período solicitado en el espejo disponible, no una consulta en vivo ni cobertura de todos los períodos.
- Los errores de refresh automático/manual conservan datos anteriores y muestran advertencia con la última lectura exitosa del CRM. El aviso desaparece solo tras publicar una lectura exitosa nueva; iniciar otro intento no lo oculta.
- El historial se apila a una columna hasta 760 px. Los estados largos permiten salto de línea; escritorio conserva sus columnas.

## Verificación

- `node --experimental-strip-types scripts/test-facto-freshness.mjs`: 19 escenarios de política y compatibilidad de etiquetas aprobados.
- `node scripts/test-facto-freshness-browser.mjs <directorio-de-resultados>`: página, hook y cliente reales; autenticación/API sintéticas, perfil aislado de Chrome y red interceptada. Cinco flujos aprobados (éxito, conflicto, cierre no confirmado, sesión vencida, fallo inicial). Incluye desconexión y sesión vencida durante refresh, conservación de datos, recuperación, estados de frescura y cero POST durante consultas. Cada POST de consolidación es simulado, nunca productivo.
- Historial comprobado mediante medidas DOM y capturas en 320, 390 y 1280 px, sin desbordamiento ni compresión de fechas. Captura de 390 px inspeccionada visualmente. No se modificaron otros controles móviles.
- Pruebas `test-accounting-read-only-refresh.mjs`, `test-facto-sync-safety.mjs` y `npm run test:accounting`: aprobadas.
- `tsc -b`, chequeo TypeScript estricto del nuevo helper y Vite build: aprobados. Build con `envDir` externo vacío, sin cargar `.env.local`, salida fuera del repositorio. Permanece aviso de bundles grandes.
- Lint de archivos afectados: tres errores existentes (`factoHeader`, `purchase`, `first` sin uso en accounting-center/index.ts) y una advertencia existente (`selectedReality` en AccountingCenterPage.tsx). Se verificaron contra las copias anteriores al cambio. Nuevos módulos y pruebas sin errores de lint.

## Evidencia y límites

Copias anteriores: `C:/Users/msanh/Documents/Codex/2026-09-30/task/freshness-backup`.
Resultados/capturas: `C:/Users/msanh/Documents/Codex/2026-09-30/task/freshness-browser-results`.
Build aislado: `C:/Users/msanh/Documents/Codex/2026-09-30/task/freshness-build-final`.

La revisión inicial estaba en main/eeebbcc. Se conservaron los cambios ajenos presentes y los observados durante el trabajo; no se hizo fetch, commit, push ni despliegue. No se cambiaron dependencias, permisos, configuración de conexión ni esquema SQL para estas tres correcciones.

La prueba de navegador usa API simulada: no acredita estado real de Facto, sesión autenticada de Marco, versión Edge desplegada ni compatibilidad de PostgREST productivo. Estos cambios requieren una publicación separadamente autorizada de frontend y función Edge; con backend antiguo el frontend muestra actualización sin confirmar.
