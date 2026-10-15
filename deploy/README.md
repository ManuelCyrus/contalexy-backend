# Pôr a API em produção numa VPS (Docker + nginx), em api.contalexy.com

Tudo corre em Docker: PostgreSQL, Redis e a API. O nginx fica à frente com https.
A API corre em duas cores (azul na porta 3101, verde na 3102, só em 127.0.0.1):
cada versão nova arranca ao lado da que está a servir, e o nginx só muda quando
a nova responde. Assim lançar não deixa a API cair e voltar atrás demora segundos.

## Primeira vez

1. Copia a pasta do backend para a VPS (por exemplo `/opt/contalex-backend`, com `git clone`).
2. `cp .env.example .env` e preenche. O essencial:
   ```
   NODE_ENV=production
   DATABASE_URL="postgresql://rumo:UMA_PASS_FORTE@postgres:5432/rumo?schema=public"
   POSTGRES_USER=rumo
   POSTGRES_PASSWORD=UMA_PASS_FORTE
   POSTGRES_DB=rumo
   REDIS_URL=redis://redis:6379
   APP_PUBLIC_URL=https://api.contalexy.com
   CORS_ORIGINS=https://contalexy.com,https://www.contalexy.com
   JWT_* , ANTHROPIC_API_KEY, STORAGE_DRIVER=s3 e S3_*, REVENUECAT_*, ADMIN_EMAILS ...
   ```
   Dentro do Docker a base chama-se `postgres` e o Redis `redis` (não `localhost`).
3. Na Cloudflare, o registo `api` (tipo A, para o IP da VPS) fica **cinzento ("DNS only")
   enquanto corres o setup**, para o certificado https ser emitido sem a Cloudflare no meio.
4. Como root, na pasta do backend:
   ```
   bash deploy/setup.sh o-teu-email@exemplo.com
   ```
   O domínio é `api.contalexy.com` por omissão (outro: `bash deploy/setup.sh EMAIL outro.dominio`).
5. Depois do setup terminar e `https://api.contalexy.com/v1/health` responder:
   - na Cloudflare põe o registo `api` laranja ("Proxied");
   - em SSL/TLS › Overview escolhe **Full (strict)**. Com "Flexible" a Cloudflare fala com o
     servidor em http, o nginx redireciona para https e fica em ciclo ("too many redirects").

O nginx já está preparado para a Cloudflare: lê o IP real de cada visitante
(`CF-Connecting-IP`, só vindo dos IPs da Cloudflare), por isso o limite de pedidos e os
registos de entradas na API veem a pessoa e não a Cloudflare. O certificado renova-se
sozinho (certbot) mesmo com o registo laranja.
   Instala Docker, nginx e certbot, arranca PostgreSQL e Redis, configura o nginx,
   lança a primeira versão, pede o certificado https e agenda uma cópia diária da base.

Se já tinhas a base no `docker-compose.yml` de desenvolvimento neste servidor, os
dados continuam (é o mesmo volume `rumo-backend_rumo_pg`); o setup pára esse contentor
antigo. Nesse caso a palavra-passe da base é a que foi usada quando ela foi criada
(no compose de desenvolvimento era `rumo`): põe essa em `POSTGRES_PASSWORD` e na `DATABASE_URL`.

## Base de dados gerida (Neon, Supabase, DigitalOcean, Railway...)

Se a base estiver num serviço online, põe o link dele na `DATABASE_URL` e os scripts
percebem sozinhos: na VPS só corre o Redis (o PostgreSQL do Docker não arranca) e as
cópias diárias fazem `pg_dump` à base online.

```
DATABASE_URL="postgresql://UTILIZADOR:PASS@HOST:5432/BASE?sslmode=require"
# Só se o serviço der dois links (um com "pooler"/porta 6543 e um direto):
# o da app vai na DATABASE_URL e o direto aqui, para as migrações.
DIRECT_URL="postgresql://UTILIZADOR:PASS@HOST-DIRETO:5432/BASE?sslmode=require"
```
- Mantém o `?sslmode=require` (estes serviços só aceitam ligações cifradas). Se der erro
  "self-signed certificate" (acontece na DigitalOcean), usa `?sslmode=require&uselibpqcompat=true`.
- Caracteres especiais na palavra-passe vão codificados (`@` → `%40`, `#` → `%23`).
- Escolhe a região mais perto da VPS (a mesma cidade, se der): cada pedido à API fala com a base várias vezes.
- Uma base nova fica vazia: o primeiro `deploy.sh` cria as tabelas (migrações). Não corras o `db:seed` em produção.
- Para levar os dados que já tens: `pg_dump "LINK_ANTIGO" --no-owner | psql "LINK_NOVO"`.
  Se o serviço tiver um link "pooler" (porta 6543 no Supabase), usa o direto (`DIRECT_URL`) para isto.

## Lançar uma versão nova

O código vem do GitHub: fazes push no teu PC e, na VPS, só corres

```
bash deploy/deploy.sh
```

Ele faz `git pull` sozinho (só avança, nunca mistura: se houver alterações feitas à
mão na pasta da VPS, pára e avisa). O `.env` não está no git, por isso o pull nunca
lhe toca. Para lançar o que já está na pasta sem ir ao GitHub: `bash deploy/deploy.sh --no-pull`.

Na primeira vez, na VPS: `git clone git@github.com:O_TEU_UTILIZADOR/o-teu-repo.git /opt/contalex-backend`
(se o repositório for privado, cria uma deploy key só de leitura no GitHub, em Settings › Deploy keys).
Constrói a imagem, aplica as migrações, arranca a nova cor, espera por `/v1/health`,
muda o nginx e pára a antiga. Se alguma coisa falhar antes da troca, a versão em
uso não é tocada e o script mostra o log do erro.

## Voltar atrás

```
bash deploy/rollback.sh          volta à versão anterior
bash deploy/rollback.sh TAG      volta a uma versão concreta
bash deploy/status.sh            mostra a versão em uso, as guardadas e os lançamentos
```
Guardam-se as últimas 5 imagens (`CONTALEX_KEEP_IMAGES`). As migrações da base não
se desfazem: escreve-as sempre de forma a que a versão anterior continue a funcionar
(acrescentar colunas e tabelas; apagar ou renomear só numa versão a seguir).

## Outras coisas úteis

- Logs: `docker logs -f contalex-api-blue` (ou `-green`; `status.sh` diz qual está em uso).
- Base de dados: `docker exec -it contalex-postgres-1 psql -U rumo -d rumo`.
- Cópias: `bash deploy/backup.sh` (também corre todos os dias às 03:30; ficam 14 dias em `/var/backups/contalex`). Copia-as também para fora da VPS de vez em quando.
- O PostgreSQL e as portas da API só ouvem em 127.0.0.1: da internet só se chega pelo nginx (80/443). Se usares firewall: `ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable`.
- Com `STORAGE_DRIVER=s3` nada fica no disco da VPS. Com `local`, os ficheiros ficam no volume `contalex_uploads`.
- O `.env` é montado no contentor tal como está (não é copiado para a imagem); depois de o mudares, corre `bash deploy/restart.sh` (reinicia a mesma versão sem deixar a API cair).
