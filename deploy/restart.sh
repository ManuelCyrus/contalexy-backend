#!/usr/bin/env bash
# Reinicia a API com a mesma versão (por exemplo depois de mudar o .env), sem a deixar cair:
# arranca a mesma imagem na outra cor, espera que responda e só depois troca.
#   bash deploy/restart.sh
source "$(dirname "$0")/lib.sh"
need_root
ACTIVE="$(active_color)"
[ "$ACTIVE" = none ] && fail "Ainda não há nenhuma versão lançada. Corre: bash deploy/deploy.sh"
exec bash "$DEPLOY_DIR/deploy.sh" --no-build "$(tag_of "$ACTIVE")"
