#!/usr/bin/env bash
# Volta para a versão anterior da API, também sem a deixar cair.
#
#   bash deploy/rollback.sh          volta para a versão que estava antes da atual
#   bash deploy/rollback.sh TAG      volta para uma versão concreta (ver: bash deploy/status.sh)
#
# Atenção: as migrações da base de dados não se desfazem. Por isso as migrações
# devem sempre só acrescentar (a versão antiga continua a funcionar com elas).
source "$(dirname "$0")/lib.sh"
need_root
need_env

ACTIVE="$(active_color)"
[ "$ACTIVE" = none ] && fail "Ainda não há nenhuma versão lançada."
TARGET="$(other_of "$ACTIVE")"
WANT="${1:-}"

if [ -z "$WANT" ]; then
  WANT="$(tag_of "$TARGET")"
  [ -n "$WANT" ] || fail "Não há versão anterior guardada. Indica uma: bash deploy/rollback.sh TAG"
fi
docker image inspect "$IMAGE:$WANT" > /dev/null 2>&1 || fail "A imagem $IMAGE:$WANT já não existe (só se guardam as últimas $KEEP_IMAGES)."

# Se o contentor parado já é desta versão, basta voltar a arrancá-lo (mais rápido).
if [ "$(tag_of "$TARGET")" = "$WANT" ] && docker ps -aq -f "name=^contalex-api-$TARGET$" | grep -q .; then
  info "A voltar a arrancar $TARGET ($WANT)"
  docker start "contalex-api-$TARGET" > /dev/null
  wait_healthy "$TARGET" || fail "A versão $WANT não respondeu. Continua em uso $ACTIVE ($(tag_of "$ACTIVE"))."
else
  start_color "$TARGET" "$WANT" || { docker rm -f "contalex-api-$TARGET" > /dev/null 2>&1 || true; fail "A versão $WANT não arrancou. Continua em uso $ACTIVE."; }
  echo "$WANT" > "$STATE_DIR/$TARGET.tag"
fi

switch_to "$TARGET"
echo "$(date -Iseconds) $WANT $TARGET rollback" >> "$STATE_DIR/releases"
retire_color "$ACTIVE"
ok "Em produção: $WANT ($TARGET). Para voltar à que estava: bash deploy/rollback.sh"
