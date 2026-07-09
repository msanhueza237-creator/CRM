# Guia: Backups automaticos de la base de datos

Hasta ahora el unico respaldo versionado del proyecto ([backup-demo-1.md](backup-demo-1.md)) es una foto del **codigo**, no de los **datos** (empresas, contactos, interacciones, campanas) que viven en el Postgres self-hosted detras de Supabase. Esta guia agrega un backup automatico de esos datos.

## Como funciona

El script [scripts/backup-database.sh](../scripts/backup-database.sh) corre `pg_dump` **dentro** del contenedor de Postgres via `docker exec`, en vez de conectarse por red al puerto de Postgres. Esto evita tener que exponer Postgres publicamente ([docs/supabase-connection-notes.md](supabase-connection-notes.md) ya recomienda no hacerlo si no es necesario) y garantiza que la version de `pg_dump` siempre coincide con la del servidor.

El script:

1. Genera un dump comprimido (`pg_dump -Fc`) con timestamp: `climactiva-crm-YYYYMMDD-HHMMSS.dump`.
2. Si el dump falla o queda vacio, borra el archivo parcial y termina con error (para que cron lo detecte).
3. Elimina automaticamente los backups mas viejos que `RETENTION_DAYS` (14 dias por defecto).

## Setup en el VPS (una sola vez)

1. Copiar al VPS `scripts/backup-database.sh` y `scripts/backup-database.env.example`.
2. Renombrar la copia a `backup-database.env` y completar los valores reales:
   - `POSTGRES_CONTAINER`: nombre exacto del contenedor de Postgres. Se obtiene con:
     ```bash
     docker ps | grep postgres
     ```
   - `POSTGRES_USER`, `POSTGRES_DB`: credenciales/nombre de la base (normalmente `postgres`/`postgres` en el stack self-hosted de Supabase).
   - `BACKUP_DIR`: carpeta del VPS donde se guardan los `.dump` (ej. `/var/backups/climactiva-crm/db`).
   - `RETENTION_DAYS`: dias de retencion (default 14).
3. Dar permiso de ejecucion:
   ```bash
   chmod +x scripts/backup-database.sh
   ```
4. Probar manualmente una vez:
   ```bash
   scripts/backup-database.sh
   ```
   Confirmar que aparece un archivo `.dump` con tamano mayor a 0 en `BACKUP_DIR`.

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
