# Guia: Backups automaticos de la base de datos

Hasta ahora el unico respaldo versionado del proyecto ([backup-demo-1.md](backup-demo-1.md)) es una foto del **codigo**, no de los **datos** (empresas, contactos, interacciones, campanas) que viven en el Postgres self-hosted detras de Supabase. Esta guia agrega un backup automatico de esos datos.

## Como funciona

El script [scripts/backup-database.sh](../scripts/backup-database.sh) corre `pg_dump` **dentro** del contenedor de Postgres via `docker exec`, en vez de conectarse por red al puerto de Postgres. Esto evita tener que exponer Postgres publicamente ([docs/supabase-connection-notes.md](supabase-connection-notes.md) ya recomienda no hacerlo si no es necesario) y garantiza que la version de `pg_dump` siempre coincide con la del servidor.

El script:

1. Adquiere un bloqueo `flock` para impedir ejecuciones superpuestas.
2. Comprueba espacio para 1,5 veces la mayor copia existente mas una reserva de 15 GB decimales. Sin espacio, no crea ni elimina respaldos.
3. Genera el dump comprimido (`pg_dump -Fc`) como `.dump.partial`. Vigila el disco cada cinco segundos; al alcanzar la reserva cancela exclusivamente la conexion de su propio dump.
4. Si falla o queda vacio/corrupto, elimina solo su parcial y conserva todas las copias completas existentes.
5. Decodifica el archivo completo con `pg_restore --file=/dev/null`, sin conectarlo a una base de datos, calcula SHA-256 y lo publica con nombre final y archivo `.sha256`.
6. Si `PRUNE_BACKUPS=true`, valida tambien las copias que conservara y elimina solo los dumps anteriores con nombre exacto reconocido. Mantiene `RETENTION_COUNT` copias, nunca menos de dos. No elimina archivos ajenos, enlaces simbolicos ni parciales de otra ejecucion.

La decodificacion y el checksum no sustituyen un ensayo de restauracion aislado.
Las fechas futuras, los cambios concurrentes o una copia retenida que no se pueda
validar bloquean la limpieza. No se borra primero para intentar hacer espacio:
si no cabe la siguiente copia, se necesita una intervencion controlada.

## Setup en el VPS (una sola vez)

1. Copiar al VPS `scripts/backup-database.sh` y `scripts/backup-database.env.example`.
2. Renombrar la copia a `backup-database.env` y completar los valores reales:
   - `POSTGRES_CONTAINER`: nombre exacto del contenedor de Postgres. Se obtiene con:
     ```bash
     docker ps | grep postgres
     ```
   - `POSTGRES_USER`, `POSTGRES_DB`: credenciales/nombre de la base (normalmente `postgres`/`postgres` en el stack self-hosted de Supabase).
   - `BACKUP_DIR`: carpeta del VPS donde se guardan los `.dump` (ej. `/var/backups/climactiva-crm/db`).
   - `RETENTION_COUNT`: copias completas verificadas a conservar (default 2, minimo 2).
   - `MIN_FREE_GB`: reserva minima, en GB decimales (default 15).
   - `CHECK_INTERVAL_SECONDS`: intervalo del control de espacio (default 5, maximo 30).
   - `PRUNE_BACKUPS`: `false` por defecto. Activar `true` solo despues de autorizar expresamente el borrado de historicos. `RETENTION_DAYS` ya no se utiliza.
3. Dar permiso de ejecucion:
   ```bash
   chmod +x scripts/backup-database.sh
   ```
4. Revisar primero el plan de solo lectura, que no genera copias, bloqueos ni borrados:

   ```bash
   scripts/backup-database.sh --plan
   ```

5. Tras confirmar la configuracion y su autorizacion, ejecutar una vez:
   ```bash
   scripts/backup-database.sh
   ```
   Confirmar el mensaje `Backup verified`, su `.sha256` y, si corresponde,
   `Retention complete`. Comprobar el espacio y las copias conservadas.

La actualizacion del frontend en Dokploy NO instala este script del sistema.
Instalarlo por separado en la ruta del cron existente, con respaldo de script y
configuracion, sin cambiar contenedor, base, usuario ni horario. La primera
ejecucion con la nueva politica puede retirar historicos de esa carpeta; debe
estar cubierta por la autorizacion de retencion. No incluye otras carpetas de
respaldos, bases de datos, logs de Supabase ni snapshots del proveedor.

Pruebas aisladas (Docker, espacio y bloqueo simulados; sin datos reales):

```bash
node --test scripts/test-backup-database.mjs
```

## Programar con cron

Agregar una linea de crontab (backup diario a las 3 AM, con log):

```bash
crontab -e
```

```cron
0 3 * * * /ruta/completa/scripts/backup-database.sh >> /var/log/climactiva-crm-backup.log 2>&1
```

## Como restaurar un backup

**Importante:** probar siempre contra una base descartable antes de restaurar sobre produccion.

```bash
# 1. Copiar el dump dentro del contenedor
docker cp climactiva-crm-20260101-030000.dump <POSTGRES_CONTAINER>:/tmp/backup.dump

# 2. Restaurar (reemplaza objetos existentes de forma segura con --clean --if-exists)
docker exec -it <POSTGRES_CONTAINER> pg_restore -U <POSTGRES_USER> -d <BASE_DESTINO> --clean --if-exists /tmp/backup.dump
```

Para restaurar sobre produccion, coordinar una ventana de mantenimiento y avisar antes de ejecutar el paso 2 contra la base real.

## Limitaciones (importante)

Este backup vive en el **mismo VPS** que la base de datos. Protege contra:

- Borrados o cambios accidentales de datos.
- Migraciones que salen mal.

**No protege** contra la perdida total del VPS (falla de disco, problema del proveedor, etc.). Para eso hace falta una copia offsite (por ejemplo subir los `.dump` a un bucket S3-compatible con `rclone`), que queda pendiente para una etapa futura porque hoy no hay credenciales de almacenamiento externo configuradas.
