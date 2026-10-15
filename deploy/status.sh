#!/usr/bin/env bash
# Mostra que versão está em produção, as guardadas e o estado dos serviços.
source "$(dirname "$0")/lib.sh"

ACTIVE="$(active_color)"
echo "Em produção: $ACTIVE ${ACTIVE:+($(tag_of "$ACTIVE"))}"
for c in blue green; do
  state="$(docker inspect -f '{{.State.Status}}' "contalex-api-$c" 2>/dev/null || echo 'não existe')"
  printf '  %-6s porta %s  %-10s %s\n' "$c" "$(port_of "$c")" "$state" "$(tag_of "$c")"
done
echo
echo "Imagens guardadas (para rollback.sh TAG):"
docker images "$IMAGE" --format '  {{.Tag}}  ({{.CreatedSince}})' | grep -v latest || true
echo
echo "Últimos lançamentos:"
tail -n 10 "$STATE_DIR/releases" 2>/dev/null | sed 's/^/  /' || echo "  (nenhum)"
echo
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-x}" docker compose -f "$DEPLOY_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" ps 2>/dev/null || true
echo "Base de dados: $(db_mode)"
