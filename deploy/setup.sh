#!/usr/bin/env bash
# Prepara a VPS de raiz e lança a primeira versão da API:
# Docker, PostgreSQL, Redis, nginx com https (Let's Encrypt), cópia diária da
# base de dados e a primeira versão da API. Pode correr-se outra vez sem estragar nada.
#
#   bash deploy/setup.sh o-teu-email@exemplo.com                     (API em api.contalexy.com)
#   bash deploy/setup.sh o-teu-email@exemplo.com outro.dominio.com   (outro domínio)
source "$(dirname "$0")/lib.sh"
need_root
EMAIL="${1:?Uso: bash deploy/setup.sh <email para o certificado https> [domínio, por omissão api.contalexy.com]}"
DOMAIN="${2:-api.contalexy.com}"
need_env
mkdir -p "$STATE_DIR"

# --- 1) Programas -----------------------------------------------------------
if ! command -v docker > /dev/null; then
  info "A instalar o Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version > /dev/null 2>&1 || fail "Falta o 'docker compose'. Instala o pacote docker-compose-plugin."
if ! command -v nginx > /dev/null || ! command -v certbot > /dev/null; then
  info "A instalar nginx e certbot"
  apt-get update -y
  apt-get install -y nginx certbot python3-certbot-nginx curl
fi
systemctl enable --now docker nginx > /dev/null 2>&1 || true

# --- 2) Confirmar o .env ----------------------------------------------------
grep -q '^NODE_ENV=production' "$ENV_FILE" || info "Aviso: põe NODE_ENV=production no .env."
DB_MODE="$(db_mode)"
if [ "$DB_MODE" = internal ]; then
  grep -q '^POSTGRES_PASSWORD=.\+' "$ENV_FILE" || fail "Define POSTGRES_PASSWORD no .env (a palavra-passe da base de dados)."
else
  if grep -Eq '^DATABASE_URL=.*@(localhost|127\.0\.0\.1)[:/]' "$ENV_FILE"; then
    fail "A DATABASE_URL aponta para localhost. Usa o endereço da base gerida (ou, para a base no Docker, o host 'postgres')."
  fi
  info "Base de dados gerida fora desta VPS ($(envval DATABASE_URL | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')): aqui só corre o Redis."
fi
if ! grep -q '^REDIS_URL=redis://redis' "$ENV_FILE"; then
  info "Aviso: para usar o Redis, põe REDIS_URL=redis://redis:6379 no .env."
fi

# --- 3) PostgreSQL e Redis --------------------------------------------------
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE")
if [ "$DB_MODE" = internal ]; then
  # A base de desenvolvimento (docker-compose.yml) usa o mesmo volume: nunca podem
  # correr as duas ao mesmo tempo sobre os mesmos ficheiros.
  for c in $(docker ps -q -f "volume=rumo-backend_rumo_pg"); do
    name="$(docker inspect -f '{{.Name}}' "$c" | tr -d /)"
    [ "$name" = contalex-postgres-1 ] && continue
    info "A parar $name (usa os mesmos dados; passa a ser servido pelo contentor de produção)"
    docker stop "$name" > /dev/null
  done
  info "A arrancar PostgreSQL e Redis"
  "${COMPOSE[@]}" up -d
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' contalex-postgres-1 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' contalex-postgres-1 2>/dev/null)" = healthy ] || fail "O PostgreSQL não arrancou: docker logs contalex-postgres-1"
  ok "PostgreSQL e Redis a correr"
else
  info "A arrancar o Redis"
  POSTGRES_PASSWORD=unused "${COMPOSE[@]}" up -d redis
  ok "Redis a correr"
fi

# --- 4) nginx ---------------------------------------------------------------
# O domínio passa pela Cloudflare: sem isto, o nginx e a API veriam só os IPs da
# Cloudflare (e o limite de pedidos por IP valeria para toda a gente ao mesmo tempo).
info "A configurar o IP real dos visitantes vindos da Cloudflare"
{
  echo "# Gerado pelo setup do Contalexy: IPs da Cloudflare (atualiza correndo o setup outra vez)"
  for v in ips-v4 ips-v6; do
    curl -fsS --max-time 10 "https://www.cloudflare.com/$v" 2>/dev/null || cat "$DEPLOY_DIR/nginx/cloudflare-$v.txt"
    echo
  done | grep -E '^[0-9a-f:.]+/[0-9]+$' | sed 's/.*/set_real_ip_from &;/'
  echo "real_ip_header CF-Connecting-IP;"
} > /etc/nginx/conf.d/cloudflare-realip.conf

info "A configurar o nginx para $DOMAIN"
SITE="/etc/nginx/sites-available/contalex-api.conf"
[ -d /etc/nginx/sites-available ] || SITE="/etc/nginx/conf.d/contalex-api.conf"
sed "s/__DOMAIN__/$DOMAIN/g" "$DEPLOY_DIR/nginx/contalex-api.conf" > "$SITE"
[ -d /etc/nginx/sites-enabled ] && ln -sf "$SITE" /etc/nginx/sites-enabled/contalex-api.conf
# Enquanto não há nenhuma versão, o upstream aponta para a porta azul.
[ -f "$UPSTREAM_FILE" ] || printf 'upstream contalex_api {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' "$(port_of blue)" > "$UPSTREAM_FILE"
nginx -t
systemctl reload nginx
ok "nginx configurado"

# --- 5) Primeira versão da API ----------------------------------------------
bash "$DEPLOY_DIR/deploy.sh"

# --- 6) https ---------------------------------------------------------------
info "A pedir o certificado https para $DOMAIN"
if certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect -n; then
  ok "https ativo: https://$DOMAIN/v1/health"
else
  info "O certificado falhou. Confirma que o DNS de $DOMAIN aponta para este servidor e corre: certbot --nginx -d $DOMAIN"
fi

# --- 7) Cópia diária da base de dados ---------------------------------------
cat > /etc/cron.d/contalex-backup <<EOF
# Cópia da base de dados todos os dias às 03:30 (guarda 14 dias)
30 3 * * * root bash $DEPLOY_DIR/backup.sh > /var/log/contalex-backup.log 2>&1
EOF
ok "Cópia diária da base em /var/backups/contalex"

echo
ok "Tudo pronto. Daqui para a frente: bash deploy/deploy.sh para lançar, bash deploy/rollback.sh para voltar atrás, bash deploy/status.sh para ver o estado."
