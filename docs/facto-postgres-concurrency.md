# Facto: concurrencia con PostgreSQL real

Verificado el 1 de octubre de 2026, con autorización de Marco para preparar PostgreSQL local y una base desechable. No se modificó producción ni se publicaron cambios.

## Procedencia e instalación mínima

- Página oficial: https://www.postgresql.org/download/windows/.
- Distribuidor de binarios enlazado allí: https://www.enterprisedb.com/download-postgresql-binaries.
- Enlace de la versión: https://sbp.enterprisedb.com/getfile.jsp?fileid=1260616.
- Destino HTTPS verificado: https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip.
- Versión ejecutada: PostgreSQL 17.11, Windows x64, compilador MSVC.
- Descarga: 381531864 bytes. SHA-256 local: `80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F`.

Se revisó la licencia PostgreSQL incluida y se conservaron los avisos de terceros. No hubo acuerdo interactivo ni aceptación de condiciones adicionales. Los ejecutables examinados no presentan firma Authenticode; la procedencia se verificó mediante la cadena de enlaces oficiales y HTTPS. El SHA-256 es una huella del archivo recibido, no una firma ni un checksum publicado por el proveedor.

Se extrajeron únicamente herramientas necesarias, bibliotecas y recursos del servidor. No se extrajeron pgAdmin/StackBuilder ni se instalaron complementos, servicios, tareas programadas o entradas PATH. No se cambió el firewall. No se creó una cuenta Windows ni una contraseña.

## Ubicación y recursos

Raíz: `C:\Users\msanh\Documents\Codex\2026-09-30\task\postgres-local-17`.

| Recurso | Ubicación / valor |
| --- | --- |
| Binarios y recursos | `pgsql`, 101705728 bytes |
| Cluster conservado | `data`, 51514374 bytes tras detener |
| Base sintética | `crm_facto_test_3b65ccbad5`, 10294963 bytes |
| Escucha durante la prueba | Solo `127.0.0.1:65439` |
| Memoria compartida configurada | `shared_buffers=32MB` |
| Conexiones máximas | 12 |
| Memoria de operación | `work_mem=4MB`, `maintenance_work_mem=32MB` |
| WAL configurado | Mínimo 32MB, máximo 128MB |
| Resultado detallado | `results\concurrency-results.json` |
| Confirmación de parada | `results\shutdown.json` |
| Registro del servidor | `server.log` |

Los seis procesos de PostgreSQL sumaban aproximadamente 19MB de memoria privada en la medición previa a la parada; no incluye toda la memoria compartida ni representa una cota máxima. El ZIP de descarga permanece separado. No se borraron artefactos ni datos.

SSPI usa la identidad Windows existente, mapeada únicamente al propietario `crm_test_owner` dentro de este cluster. `pg_hba.conf` restringe ese acceso a loopback y rechaza los demás usuarios. Los roles de autenticación simulados de Supabase son NOLOGIN. No se reutilizaron credenciales ni archivos de configuración de producción.

## Pruebas y evidencia

El script abrió sesiones psql persistentes con backend PID **23984** y **25760**. Verificó que fueran distintos y observó la espera real mediante `pg_blocking_pids`, antes de liberar cada transacción.

1. La segunda solicitud de consolidación espera a la primera; al confirmar esta recibe `active`. Queda una sola ejecución `running`.
2. El heartbeat espera una escritura en curso y renueva la reserva después del commit, sin interbloqueo.
3. Una solicitud de consolidación concurrente no bloquea la inserción de un documento por su clave foránea. Se verifica el orden de bloqueos y `FOR NO KEY UPDATE`.
4. Al terminar abruptamente un cliente con una transacción abierta, su importe no confirmado se revierte. Tras vencer la reserva sintética, la siguiente solicitud cierra la ejecución anterior como fallida y obtiene una nueva.
5. El trabajador anterior no puede escribir ni finalizar la nueva ejecución; el token actual sí permite continuar.
6. Un documento contabilizado desde la otra conexión conserva su estado e importe. Completar/cancelar libera la reserva y deja cero ejecuciones activas.

**Resultado: seis escenarios aprobados.** Inicio `2026-10-01T10:53:52.288Z`; fin `2026-10-01T10:53:53.039Z`. Las respuestas `FACTO_SYNC_LEASE_LOST` registradas son rechazos esperados de los casos negativos.

Se ejecutó el SQL actual de `accounting_center.sql`, `accounting_facto_history.sql` y `accounting_facto_sync_safety.sql`; sus hashes están en el resultado JSON. El bootstrap proporciona tablas/funciones auth/storage sintéticas. Se omite únicamente la instalación de pgcrypto, porque `gen_random_uuid` es nativo en esta versión y no se necesita ese complemento.

## Alcance y límites

Son conexiones y bloqueos PostgreSQL reales, no PGlite. Para acelerar el caso de vencimiento se modificó solo la fecha de expiración de la reserva sintética; no se esperaron tres minutos. Se prueban los RPC y triggers de base de datos, simulando el contexto `request.headers` de PostgREST. No se levantó PostgREST ni una función Edge y no se llamó a Facto.

Esto no acredita la última sincronización productiva, la versión real del servidor productivo ni su estado de disco. Tampoco sustituye la coordinación de SQL/backend/frontend previa a un despliegue autorizado.

## Estado final y reproducción

Servidor detenido ordenadamente el `2026-10-01T10:55:07.7257515Z`. Se confirmó `pg_ctl: no server running`, ausencia de `postmaster.pid` y ausencia de listener en el puerto 65439. No hay arranque automático. Los datos se conservaron.

El script `scripts/test-facto-sync-concurrency.mjs` exige rutas explícitas, fija la conexión a loopback, comprueba que el directorio real del servidor coincida con el cluster desechable y crea una base nueva por ejecución. No lee contraseñas, no carga `.psqlrc` ni elimina bases. Solo debe ejecutarse con el entorno de pruebas iniciado deliberadamente por el usuario Windows autorizado.

```powershell
$pgTest = 'C:\Users\msanh\Documents\Codex\2026-09-30\task\postgres-local-17'
# Iniciar manualmente, sin registrar servicio:
& "$pgTest\pgsql\bin\pg_ctl.exe" -D "$pgTest\data" -l "$pgTest\server.log" -w start
# Desde el repositorio CRM climactiva:
node scripts/test-facto-sync-concurrency.mjs "--repo=$PWD" "--pg-bin=$pgTest\pgsql\bin" "--data=$pgTest\data" "--output=$pgTest\results" --port=65439
# Detener al finalizar:
& "$pgTest\pgsql\bin\pg_ctl.exe" -D "$pgTest\data" -w -t 30 -m fast stop
```

En ejecución automatizada de Codex, mantener la sesión del proceso activa durante las pruebas y detenerlo explícitamente al finalizar: la plataforma termina procesos hijos al cerrar su sesión. No usar `Start-Process -Wait` para el arranque, porque puede esperar también al servidor hijo; esperar únicamente la salida de `pg_ctl`.

Para recuperar espacio se podrá retirar el ZIP o el entorno después de aprobación. No se realizó limpieza destructiva.
