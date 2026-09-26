#!/usr/bin/env bash
# Retention runs only after a new dump and all retained copies pass validation.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/backup-database.env" ]]; then source "$SCRIPT_DIR/backup-database.env"; fi
: "${POSTGRES_CONTAINER:?Missing POSTGRES_CONTAINER}"
: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${POSTGRES_DB:?Missing POSTGRES_DB}"
: "${BACKUP_DIR:?Missing BACKUP_DIR}"
RETENTION_COUNT="${RETENTION_COUNT:-2}"
MIN_FREE_GB="${MIN_FREE_GB:-15}"
PRUNE_BACKUPS="${PRUNE_BACKUPS:-false}"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-5}"
for value in "$RETENTION_COUNT" "$MIN_FREE_GB" "$CHECK_INTERVAL_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ && ${#value} -le 6 ]] || exit 2
done
(( RETENTION_COUNT >= 2 && CHECK_INTERVAL_SECONDS <= 30 )) || exit 2
[[ "$PRUNE_BACKUPS" = true || "$PRUNE_BACKUPS" = false ]] || exit 2
BACKUP_DIR="${BACKUP_DIR%/}"
[[ "$BACKUP_DIR" = /* && "$BACKUP_DIR" != / && "$BACKUP_DIR" != /var && "$BACKUP_DIR" != /var/backups && ! -L "$BACKUP_DIR" ]] || exit 2
MODE="${1:---run}"
[[ $# -le 1 && ( "$MODE" = --run || "$MODE" = --plan ) ]] || exit 2
log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }
list_backups() {
  while IFS= read -r -d '' file; do
    [[ "${file##*/}" =~ ^climactiva-crm-[0-9]{8}-[0-9]{6}\.dump$ ]] && printf '%s\0' "$file"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'climactiva-crm-*.dump' -print0) | sort -zr
}
free_bytes() { df -B1 --output=avail -- "$BACKUP_DIR" | tail -n 1 | tr -d ' '; }
if [[ "$MODE" = --plan ]]; then
  [[ -d "$BACKUP_DIR" && "$(readlink -f "$BACKUP_DIR")" = "$BACKUP_DIR" ]] || exit 2
  log "READ ONLY: retain=$RETENTION_COUNT minimum_free_GB=$MIN_FREE_GB pruning=$PRUNE_BACKUPS"
  mapfile -d '' -t files < <(list_backups)
  for index in "${!files[@]}"; do
    if (( index < RETENTION_COUNT )); then label=KEEP; else label=ELIGIBLE_AFTER_NEW_VERIFIED_BACKUP; fi
    printf '%s %s\n' "$label" "${files[$index]}"
  done
  exit 0
fi
mkdir -p -- "$BACKUP_DIR"
[[ "$(readlink -f "$BACKUP_DIR")" = "$BACKUP_DIR" ]] || exit 2
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { log 'Another backup owns the lock; no changes.'; exit 75; }
minimum_free=$(( MIN_FREE_GB * 1000000000 ))
mapfile -d '' -t files < <(list_backups)
largest=1000000000
for file in "${files[@]}"; do
  size=$(stat -c %s -- "$file")
  (( size <= largest )) || largest=$size
done
required=$(( largest + largest / 2 + minimum_free ))
available=$(free_bytes)
[[ "$available" =~ ^[0-9]+$ ]] || exit 2
if (( available < required )); then
  log "Insufficient space: free=$available required=$required; existing backups retained."
  exit 3
fi
timestamp=$(date +%Y%m%d-%H%M%S)
final="$BACKUP_DIR/climactiva-crm-$timestamp.dump"
partial="$final.partial"
for path in "$final" "$partial" "$final.sha256" "$partial.sha256"; do [[ ! -e "$path" && ! -L "$path" ]] || exit 2; done
app_name="crm_backup_${timestamp//-/_}_$$"
dump_pid=''
owned_partial=false
cancel_dump() {
  # Cancel only this job's read-only connection, never other database sessions.
  timeout 10 docker exec -e PGCONNECT_TIMEOUT=5 "$POSTGRES_CONTAINER" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 \
    -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = '$app_name' and backend_type = 'client backend' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  kill "$dump_pid" 2>/dev/null || true
  wait "$dump_pid" 2>/dev/null || true
  dump_pid=''
}
cleanup() {
  [[ -z "$dump_pid" ]] || cancel_dump
  if [[ "$owned_partial" = true && -f "$partial" && ! -L "$partial" ]]; then rm -- "$partial"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log "Starting logical backup: ${final##*/}"
(set -o noclobber; : > "$partial")
owned_partial=true
docker exec -e "PGAPPNAME=$app_name" -e PGCONNECT_TIMEOUT=10 "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$partial" &
dump_pid=$!
while kill -0 "$dump_pid" 2>/dev/null; do
  available=$(free_bytes)
  if [[ ! "$available" =~ ^[0-9]+$ ]] || (( available < minimum_free )); then
    log 'Disk reserve reached; cancelling this backup and preserving completed copies.'
    cancel_dump
    exit 3
  fi
  sleep "$CHECK_INTERVAL_SECONDS"
done
if wait "$dump_pid"; then dump_pid=''; else dump_pid=''; log 'pg_dump failed; no completed backup removed.'; exit 1; fi
declare -A verified
verify_archive() {
  local file="$1" before after hash
  [[ -f "$file" && ! -L "$file" && -s "$file" && ! -L "$file.sha256" ]] || return 1
  before=$(stat -c '%s:%Y:%i' -- "$file")
  docker exec -i "$POSTGRES_CONTAINER" pg_restore --exit-on-error --file=/dev/null < "$file" || return 1
  hash=$(sha256sum -- "$file" | awk '{print $1}')
  after=$(stat -c '%s:%Y:%i' -- "$file")
  [[ "$before" = "$after" && "$hash" =~ ^[0-9a-f]{64}$ ]] || return 1
  verified["$file"]="$before"
  printf '%s  %s\n' "$hash" "${file##*/}" > "$file.sha256"
}
if ! verify_archive "$partial"; then log 'Archive validation failed; existing copies retained.'; exit 1; fi
mv -- "$partial" "$final"
owned_partial=false
verified["$final"]="${verified[$partial]}"
sed "s/\.dump\.partial$/\.dump/" "$partial.sha256" > "$final.sha256"
rm -- "$partial.sha256"
log "Backup verified: ${final##*/}, bytes=$(stat -c %s -- "$final")"
if [[ "$PRUNE_BACKUPS" != true ]]; then log 'Retention deletion is disabled.'; exit 0; fi
mapfile -d '' -t files < <(list_backups)
if (( ${#files[@]} < RETENTION_COUNT )); then log 'Not enough completed copies to prune.'; exit 0; fi
[[ "${files[0]}" = "$final" ]] || { log 'Unexpected future backup timestamp; no pruning.'; exit 1; }
declare -A original_stats
for file in "${files[@]}"; do original_stats["$file"]=$(stat -c '%s:%Y:%i' -- "$file"); done
for (( index=0; index<RETENTION_COUNT; index++ )); do
  file="${files[$index]}"
  if [[ -z "${verified[$file]:-}" ]] && ! verify_archive "$file"; then
    log "Retained archive failed validation: ${file##*/}; no historical files removed."
    exit 1
  fi
done
for (( index=0; index<RETENTION_COUNT; index++ )); do
  file="${files[$index]}"
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%s:%Y:%i' -- "$file")" = "${verified[$file]}" ]] || exit 1
done
removed=0
for (( index=RETENTION_COUNT; index<${#files[@]}; index++ )); do
  file="${files[$index]}"
  [[ -f "$file" && ! -L "$file" && "$(readlink -f "$file")" = "$file" && "$(stat -c '%s:%Y:%i' -- "$file")" = "${original_stats[$file]}" ]] || { log 'Concurrent backup change; pruning stopped.'; exit 1; }
  rm -- "$file"
  if [[ -f "$file.sha256" && ! -L "$file.sha256" ]]; then rm -- "$file.sha256"; fi
  removed=$(( removed + 1 ))
done
log "Retention complete: retained=$RETENTION_COUNT removed=$removed free_bytes=$(free_bytes)"
