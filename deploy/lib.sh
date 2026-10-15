#!/usr/bin/env bash
# Funções comuns aos scripts de deploy. Não se corre sozinho.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
ENV_FILE="${CONTALEX_ENV_FILE:-$APP_DIR/.env}"
STATE_DIR="${CONTALEX_STATE_DIR:-/var/lib/contalex}"
IMAGE="contalex-api"
NETWORK="contalex"
UPSTREAM_FILE="${CONTALEX_UPSTREAM_FILE:-/etc/nginx/conf.d/contalex-upstream.conf}"
KEEP_IMAGES="${CONTALEX_KEEP_IMAGES:-5}"

# Cada cor tem a sua porta no servidor (só em 127.0.0.1; o nginx é a porta da frente).
port_of() { [ "$1" = blue ] && echo 3101 || echo 3102; }
other_of() { [ "$1" = blue ] && echo green || echo blue; }

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || fail "Corre este script como root (ou com um utilizador com permissões de root)."; }
need_env() {
  [ -f "$ENV_FILE" ] || fail "Não encontrei $ENV_FILE. Copia .env.example para .env e preenche-o."
  grep -q '^DATABASE_URL=' "$ENV_FILE" || fail "Falta DATABASE_URL em $ENV_FILE."
}

envval() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }

# internal = PostgreSQL no Docker desta VPS (host "postgres"); external = base gerida
# noutro sítio (Neon, Supabase, DigitalOcean, ...): aí só o Redis corre aqui.
db_mode() {
  local host
  host="$(envval DATABASE_URL | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')"
  [ "$host" = postgres ] && echo internal || echo external
}

active_color() { cat "$STATE_DIR/active" 2>/dev/null || echo none; }
tag_of() { cat "$STATE_DIR/$1.tag" 2>/dev/null || echo ""; }

# Arranca uma cor com uma imagem e espera que responda em /v1/health.
start_color() {
  local color="$1" tag="$2" port
  port="$(port_of "$color")"
  docker rm -f "contalex-api-$color" > /dev/null 2>&1 || true
  info "A arrancar $color ($IMAGE:$tag) na porta $port"
  docker run -d --name "contalex-api-$color" \
    --restart unless-stopped \
    --network "$NETWORK" \
    -v "$ENV_FILE:/app/.env:ro" \
    -v contalex_uploads:/app/uploads \
    -e NODE_ENV=production -e PORT=3000 \
    -p "127.0.0.1:$port:3000" \
    --log-opt max-size=20m --log-opt max-file=5 \
    "$IMAGE:$tag" > /dev/null
  wait_healthy "$color"
}

wait_healthy() {
  local color="$1" port i
  port="$(port_of "$color")"
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/v1/health" > /dev/null 2>&1; then
      ok "$color responde em http://127.0.0.1:$port/v1/health"
      return 0
    fi
    if ! docker ps -q -f "name=^contalex-api-$color$" | grep -q .; then break; fi
    sleep 2
  done
  echo "--- últimas linhas do log de $color ---" >&2
  docker logs --tail 60 "contalex-api-$color" >&2 || true
  return 1
}

# Aponta o nginx para uma cor (sem cortar ligações: reload, não restart).
switch_to() {
  local color="$1" port
  port="$(port_of "$color")"
  cat > "$UPSTREAM_FILE" <<EOF
# Gerado pelo deploy do Contalexy: versão em uso = $color ($(tag_of "$color"))
upstream contalex_api {
    server 127.0.0.1:$port max_fails=3 fail_timeout=10s;
    keepalive 32;
}
EOF
  nginx -t > /dev/null 2>&1 || { nginx -t; fail "A configuração do nginx tem erros; não mudei de versão."; }
  systemctl reload nginx
  echo "$color" > "$STATE_DIR/active"
  ok "O nginx passou a enviar os pedidos para $color"
}

# Pára a cor antiga depois de os pedidos que já estavam a meio terminarem.
# O contentor fica parado (não apagado) para se poder voltar atrás num segundo.
retire_color() {
  local color="$1"
  docker ps -q -f "name=^contalex-api-$color$" | grep -q . || return 0
  info "A deixar terminar os pedidos em curso em $color (${CONTALEX_DRAIN_SECONDS:-15}s)"
  sleep "${CONTALEX_DRAIN_SECONDS:-15}"
  docker stop -t 30 "contalex-api-$color" > /dev/null
  ok "$color parado (fica guardado para voltar atrás)"
}

# Guarda as últimas imagens; apaga as mais antigas que não estejam em uso.
prune_images() {
  local keep used
  used="$(tag_of blue) $(tag_of green)"
  keep="$(tail -n "$KEEP_IMAGES" "$STATE_DIR/releases" 2>/dev/null | awk '{print $2}')"
  docker images "$IMAGE" --format '{{.Tag}}' | grep -v '^latest$' | while read -r t; do
    case " $used $keep " in *" $t "*) ;; *) docker rmi "$IMAGE:$t" > /dev/null 2>&1 || true ;; esac
  done
}
