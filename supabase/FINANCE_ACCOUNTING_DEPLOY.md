# Activación de Finanzas y Contabilidad

Esta entrega agrega el Centro de Finanzas y Contabilidad sin reemplazar Facto ni
el módulo de Comercio Exterior. Facto y Comercio Exterior actúan como fuentes;
el libro contable del CRM mantiene documentos, pagos, movimientos, conciliaciones
y asientos como entidades separadas y auditables.

## Orden de activación

1. Crear un respaldo de la base de datos de producción.
2. Ejecutar `supabase/accounting_center.sql` en Supabase Studio con rol
   `postgres`. El archivo es idempotente y no elimina información histórica.
3. Desplegar la Edge Function `accounting-center` desde
   `supabase/functions/accounting-center`.
4. Confirmar que la función recibe las variables ya usadas por el proyecto:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y
   `CRM_APP_URL`. No copiar secretos al frontend.
5. Redesplegar el CRM para habilitar la ruta `/finanzas-contabilidad`.
6. Ingresar como `administrador` o con el rol `finanzas` y abrir el módulo.

## Primera verificación

1. Abrir **Finanzas y Contabilidad > Fuentes**.
2. Ejecutar **Sincronizar Facto** y revisar el resultado antes de contabilizar.
3. Ejecutar **Sincronizar Comercio Exterior**. Se importan documentos de forma
   idempotente y quedan pendientes de revisión; no se crean pagos ni asientos
   automáticos.
4. En **Bancos**, cargar una cartola pequeña y revisar la vista previa. Volver a
   cargar el mismo archivo debe marcar sus movimientos como duplicados.
5. Crear un asiento de prueba en borrador, validarlo y contabilizarlo. Verificar
   que Debe y Haber sean iguales y que la reversa genere un asiento compensatorio.
6. Generar Balance de 8 Columnas, Estado de Resultados y Flujo de Caja.

## Seguridad operacional

- Un documento de Facto no equivale a un pago.
- Un movimiento bancario no se contabiliza hasta ser conciliado y aprobado.
- Los asientos contabilizados son inmutables; se corrigen mediante reversa.
- Un período cerrado no acepta movimientos nuevos.
- Los archivos originales se conservan en el bucket privado
  `accounting-evidence`.
- La sincronización del CRM nunca escribe de vuelta en Facto.

## Automatización posterior

La sincronización puede programarse desde Dokploy o un job existente llamando la
Edge Function con credenciales de servicio. Activarla solo después de validar
manualmente la normalización de Facto en producción. Los trabajos deben registrar
su resultado en `accounting_jobs` y conservar una clave de idempotencia.

## Recuperación

Ante un problema, deshabilitar temporalmente la ruta del frontend y la Edge
Function. No eliminar tablas ni asientos. Restaurar desde el respaldo únicamente
si la migración falló antes de completar su transacción.
