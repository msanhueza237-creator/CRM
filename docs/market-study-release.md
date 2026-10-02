# Publicación de Estudio de Mercado

Revisión preparada sobre `24631cd8a3099f4d77118d9755d37c71f6cc239a`, con autorización específica para tablas, commit, push y despliegue. El árbol original contiene trabajo ajeno: la revisión publicable se aisló en `tmp/market-release-20261002`. Solo archivos del módulo, sus pruebas/documentación y enlaces de ruta/navegación/Dashboard/contrato de tipos.

## Orden y compatibilidad

1. Validar backup, checksum y decodificación completa con pg_restore a `/dev/null` (sin restaurar producción). Conservar esquema y referencia de imagen anterior.
2. Aplicar `supabase/market_study.sql` en una transacción con ON_ERROR_STOP. Es aditivo; no toca precios, costos, facturas o saldos. No reejecutar ciegamente: los triggers tienen nombres únicos y la transacción fallará si ya existe la instalación.
3. Copiar solo `market-study/index.ts`, `market-study/handler.ts` y `_shared/market-study-contract.ts` al volumen existente. Las seis dependencias de lectura de crm-copilot se verificaron por hash y no se reemplazan. Router main ya resuelve por directorio; no se reinicia Supabase ni se cambia JWT/CORS global.
4. Verificar la función, esquema y permisos antes del push de frontend. El frontend previo no usa las tablas nuevas; el nuevo maneja backend no disponible sin inventar ranking.
5. Push a main activa Dokploy. Esperar ejecución asociada al SHA, estado done, servicio sano y verificar assets públicos contra los servidos por el contenedor.

## Recuperación prevista

Artefactos remotos acotados: `/var/backups/climactiva-crm/market-release-20261002/`, esquema anterior, dependencias anteriores y manifiesto SHA256. Respaldo completo previo: `/var/backups/climactiva-crm/db/climactiva-crm-20261002-030002.dump` con checksum. Esta comprobación de lectura no equivale a un ensayo de restauración completa en otro servidor.

Imagen anterior conservada: `crm-climactiva-crm-hkjzwz:rollback-market-24631cd`, ID `sha256:a13eeecc6cd656ec29bf5867d3d7d7af90e218d390cc79853df811fbc1d4e563`. Si el nuevo frontend falla, el procedimiento de recuperación devuelve el servicio Dokploy a esa imagen/revisión y verifica assets; no revierte la base completa.

Rollback del módulo sin pérdida de información: retirar la ruta del frontend mediante reversión del commit, retirar/desactivar solamente el nuevo handler y revocar EXECUTE de service_role sobre `market_study_import(uuid,jsonb)`/`market_study_review(uuid,jsonb)`, conservando las tablas append-only y las investigaciones que pudieran existir. No restaurar un dump global sobre datos posteriores. Eliminar físicamente tablas o modificar configuración/seguridad ajena exige revisar y aprobar ese alcance antes. Estos pasos son un plan de contingencia, no se ejecutan durante una publicación exitosa.

## Validación y límites

13 pruebas de dominio/API/SQL PGlite, tipos de Edge Function y build tsc/Vite, lint del módulo, navegador sintético 1280/390/320 con toda red interceptada. No existen workflows .github versionados en la revisión base; no se eluden protecciones del remoto ni se utiliza force push. Persiste aviso general de bundle grande.

No crear sesión, token, usuario, cuenta de servicio o dot para verificar producción. Una petición sin sesión solo comprueba rechazo de acceso y arranque del handler; assets y ruta SPA no prueban una sesión autenticada. La inspección SQL final es de lectura y comprueba tablas vacías, RLS y grants, sin cargar datos sintéticos. La conexión automática del dot permanece inactiva.
