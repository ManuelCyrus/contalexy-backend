#!/usr/bin/env bash
# Cópia da base de dados (comprimida) para /var/backups/contalex; guarda 14 dias.
# Repor uma cópia:
#   gunzip -c /var/backups/contalex/FICHEIRO.sql.gz | docker exec -i contalex-postgres-1 psql -U rumo -d rumo
source "$(dirname "$0")/lib.sh"
need_env
DEST="${CONTALEX_BACKUP_DIR:-/var/backups/contalex}"
mkdir -p "$DEST"
if [ "$(db_mode)" = external ]; then
  # Base gerida noutro serviço: pg_dump a partir de um contentor, pela DIRECT_URL se houver.
  URL="$(envval DIRECT_URL)"; [ -n "$URL" ] || URL="$(envval DATABASE_URL)"
  URL="${URL%%\?*}?sslmode=require"
  FILE="$DEST/contalex-$(date +%Y%m%d-%H%M%S).sql.gz"
  docker run --rm "${CONTALEX_PG_IMAGE:-postgres:17-alpine}" pg_dump "$URL" --no-owner --no-privileges | gzip > "$FILE"
else
  POSTGRES_USER="$(envval POSTGRES_USER)"; POSTGRES_DB="$(envval POSTGRES_DB)"
  FILE="$DEST/contalex-$(date +%Y%m%d-%H%M%S).sql.gz"
  docker exec contalex-postgres-1 pg_dump -U "${POSTGRES_USER:-rumo}" -d "${POSTGRES_DB:-rumo}" --no-owner | gzip > "$FILE"
fi
find "$DEST" -name 'contalex-*.sql.gz' -mtime +"${CONTALEX_BACKUP_DAYS:-14}" -delete
ok "Cópia feita: $FILE ($(du -h "$FILE" | cut -f1))"
