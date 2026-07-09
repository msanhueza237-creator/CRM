#!/usr/bin/env bash
#
# Backup automatico de la base de datos Postgres self-hosted de Clima Activa CRM.
# Corre pg_dump DENTRO del contenedor de Postgres via `docker exec`, para no
# depender de exponer el puerto de Postgres en la red del VPS.
#
# Uso (en el VPS, via cron):
#   scripts/backup-database.sh
#
# Configuracion: scripts/backup-database.env (ver backup-database.env.example)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/backup-database.env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

: "${POSTGRES_CONTAINER:?Falta POSTGRES_CONTAINER en backup-database.env}"
: "${POSTGRES_USER:?Falta POSTGRES_USER en backup-database.env}"
: "${POSTGRES_DB:?Falta POSTGRES_DB en backup-database.env}"
: "${BACKUP_DIR:?Falta BACKUP_DIR en backup-database.env}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/climactiva-crm-$timestamp.dump"

echo "[$(date -Iseconds)] Iniciando backup de '$POSTGRES_DB' (contenedor: $POSTGRES_CONTAINER) -> $backup_file"

if ! docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup_file"; then
  echo "[$(date -Iseconds)] ERROR: pg_dump fallo, eliminando archivo parcial" >&2
  rm -f "$backup_file"
  exit 1
fi

if [ ! -s "$backup_file" ]; then
  echo "[$(date -Iseconds)] ERROR: el backup quedo vacio" >&2
  rm -f "$backup_file"
  exit 1
fi

size_kb=$(( $(stat -c%s "$backup_file" 2>/dev/null || stat -f%z "$backup_file") / 1024 ))
echo "[$(date -Iseconds)] Backup OK: $backup_file (${size_kb} KB)"

deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'climactiva-crm-*.dump' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
if [ "$deleted" -gt 0 ]; then
  echo "[$(date -Iseconds)] Se eliminaron $deleted backup(s) con mas de $RETENTION_DAYS dias"
fi

remaining=$(find "$BACKUP_DIR" -maxdepth 1 -name 'climactiva-crm-*.dump' | wc -l)
echo "[$(date -Iseconds)] Backups actuales en $BACKUP_DIR: $remaining"
