#!/usr/bin/env bash
# Lança uma versão nova da API sem a deixar cair (azul/verde):
#   1. constrói a imagem nova
#   2. aplica as migrações da base de dados
#   3. arranca a versão nova ao lado da que está a correr e espera que responda
#   4. muda o nginx para a nova (reload, sem cortar ligações)
#   5. pára a antiga, que fica guardada para voltar atrás (rollback.sh)
# Se algo falhar antes do passo 4, a versão em uso nunca é tocada.
#
#   bash deploy/deploy.sh                  vai buscar o código novo ao GitHub (git pull) e lança
#   bash deploy/deploy.sh --no-pull        lança o código que já está na pasta, sem git pull
#   bash deploy/deploy.sh --no-build TAG   reaproveita uma imagem já construída
source "$(dirname "$0")/lib.sh"
need_root
need_env
mkdir -p "$STATE_DIR"
cd "$APP_DIR"

docker network inspect "$NETWORK" > /dev/null 2>&1 || fail "A rede $NETWORK não existe. Corre primeiro: bash deploy/setup.sh <domínio> <email>"

if [ "${1:-}" != "--no-build" ] && [ "${1:-}" != "--no-pull" ] && [ -d "$APP_DIR/.git" ]; then
  # O .env e os uploads não estão no git (.gitignore): o pull nunca lhes toca.
  # O pull corre como o dono da pasta (que tem a chave SSH do GitHub), não como root.
  OWNER="$(stat -c %U "$APP_DIR")"
  info "A ir buscar o código novo ao GitHub (como $OWNER)"
  if [ "$OWNER" = root ]; then git pull --ff-only; else runuser -u "$OWNER" -- git -C "$APP_DIR" pull --ff-only; fi || fail "O git pull falhou (há alterações feitas à mão nesta pasta?). Vê 'git status'; a versão em uso continua igual."
  # O próprio deploy pode ter mudado com o pull: corre a versão nova dele.
  exec bash "$DEPLOY_DIR/deploy.sh" --no-pull
fi

if [ "${1:-}" = "--no-build" ]; then
  TAG="${2:?Indica a TAG da imagem}"
  docker image inspect "$IMAGE:$TAG" > /dev/null 2>&1 || fail "Não existe a imagem $IMAGE:$TAG."
else
  REV="$(git -c safe.directory="$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  TAG="$(date +%Y%m%d-%H%M%S)${REV:+-$REV}"
  info "A construir $IMAGE:$TAG"
  docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
fi

ACTIVE="$(active_color)"
if [ "$ACTIVE" = none ]; then NEW=blue; else NEW="$(other_of "$ACTIVE")"; fi

# As migrações correm uma vez, com o código novo, antes de o arrancar. Têm de ser
# compatíveis com a versão antiga (que continua a servir até à troca): acrescentar
# colunas e tabelas sim, apagar ou renomear só numa versão seguinte.
info "A aplicar as migrações"
docker run --rm --network "$NETWORK" -v "$ENV_FILE:/app/.env:ro" "$IMAGE:$TAG" npx prisma migrate deploy || fail "As migrações falharam. A versão em uso continua igual."

if ! start_color "$NEW" "$TAG"; then
  docker rm -f "contalex-api-$NEW" > /dev/null 2>&1 || true
  fail "A versão nova não arrancou (o log está acima). A versão em uso continua igual."
fi
echo "$TAG" > "$STATE_DIR/$NEW.tag"

switch_to "$NEW"
echo "$(date -Iseconds) $TAG $NEW" >> "$STATE_DIR/releases"
[ "$ACTIVE" != none ] && retire_color "$ACTIVE"
prune_images

ok "Versão $TAG em produção ($NEW). Para voltar atrás: bash deploy/rollback.sh"
