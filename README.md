# Contalexy: backend

API da app de finanças pessoais **Contalexy**: registar, planear, controlar, simular e decidir melhor.

Contas e movimentos, plano do mês (planeado vs. real), limites por categoria, objetivos, planos (viagens, listas de compras, plano de negócio), empréstimos com lembretes, simulador "E se eu fizer isto?", análise de desperdícios, despesas partilhadas (Spaces), acompanhamento (alguém de confiança vê os teus gastos), relatórios, Premium com RevenueCat, códigos promocionais, área de administração e IA com Claude.

**Stack:** NestJS 11, Prisma 7 (adaptador `pg`), PostgreSQL 17, Zod e JWT

---


**Produção numa VPS (Docker, Redis, nginx, https, lançar sem parar e voltar atrás):** ver [`deploy/README.md`](deploy/README.md).

## Arrancar em 5 minutos

```bash
# 1) Base de dados (ou usa a tua própria PostgreSQL)
docker compose up -d

# 2) Configuração
cp .env.example .env        # mete pelo menos os dois JWT_*_SECRET

# 3) Dependências + cliente Prisma (o postinstall gera o cliente)
npm install

# 4) Criar as tabelas e os dados de demonstração (NÃO saltes este passo)
npm run db:setup            # = npx prisma migrate deploy  +  npm run db:seed
                            # conta demo@contalex.app / demo1234 (só em desenvolvimento!)

# 5) Arrancar
npm run start:dev           # abre http://localhost:3000/v1/health
```

**Já tinhas a versão anterior** (pasta `rumo-backend`)? O mais simples é o script `atualizar_contalex.sh` que veio com os zips: troca o código na pasta que já tens (sem tocar no `.env`), instala, cria as tabelas e atualiza também a app. À mão, dentro da pasta nova:

```bash
cp ../rumo-backend/.env .env      # a tua configuração
npm install
npx prisma migrate deploy         # aplica só o que falta; não apaga nada
npm run db:seed                   # opcional: (re)cria a conta de demonstração
npm run start:dev
```

A base de dados é a mesma (o `docker-compose.yml` fixa o nome do projeto), por isso a pasta antiga pode ser apagada.

- **App:** no emulador Android a API está em `http://10.0.2.2:3000/v1`; num telemóvel real usa o IP do computador (ex.: `http://192.168.1.20:3000/v1`).
- **Administração:** fica no site (projeto `contalex-web`, em `/admin`); entra com `demo@contalex.app` / `demo1234`. O backend só serve as rotas `/v1/admin/*`.
- **Sem o passo 4** o servidor não arranca e diz porquê ("A base de dados ainda não tem as tabelas"). O mesmo acontece depois de atualizares o código para uma versão com alterações à base de dados: corre `npm install` e `npx prisma migrate deploy` (não apaga nada; aplica só o que falta).

> ⚠️ `npm run db:seed` cria uma conta **administradora** com palavra-passe conhecida. É para desenvolvimento: com `NODE_ENV=production` recusa-se a correr.

## Testes

```bash
npm test                    # testes unitários (datas, dinheiro, simulador, empréstimos, receita…)

# Testes de ponta a ponta contra uma base de dados de TESTE (nunca a tua):
createdb rumo_test          # ou pelo docker: docker compose exec postgres createdb -U rumo rumo_test
DATABASE_URL="postgresql://rumo:rumo@localhost:5432/rumo_test" npx prisma migrate deploy
DATABASE_URL_TEST="postgresql://rumo:rumo@localhost:5432/rumo_test" npm run test:e2e
```

## Mudar o modelo de dados

Edita `prisma/schema.prisma` e cria a migração:

```bash
npx prisma migrate dev --name descricao_da_mudanca
```

## Produção

- `Dockerfile` incluído (aplica as migrações ao arrancar). Funciona em Railway, Render, Fly.io ou numa VPS.
- Variáveis obrigatórias: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `APP_PUBLIC_URL`.
- A pasta `UPLOADS_DIR` tem de ser um volume persistente (recibos e fotos).
- `BILLING_DEV_GRANTS=false` em produção, e **não** corras o `db:seed`.
- Para entrares na área de administração: cria a tua conta na app e põe o teu email em `ADMIN_EMAILS` (ver abaixo).

---

## Ficheiros (recibos, fotos, logótipos)

`STORAGE_DRIVER=local` guarda em `UPLOADS_DIR` (só para desenvolvimento). `STORAGE_DRIVER=s3` manda tudo para o bucket (DigitalOcean Spaces ou S3) e não escreve nada no servidor. Ao arrancar, o backend diz qual está a usar: `Ficheiros: S3 (bucket ...)` ou `Ficheiros: disco local (...)`. Se mudaste o `.env` e continua a dizer "disco local":

1. O processo tem de ser reiniciado (`pm2 restart contalex` ou parar e arrancar de novo); o `.env` só é lido ao arrancar.
2. Uma variável já definida no ambiente ganha ao `.env` (o pm2 `ecosystem.config.js` com `env: { STORAGE_DRIVER: 'local' }`, um `Environment=` no systemd ou um `environment:` no docker-compose). Confirma com `pm2 env <id>` ou `printenv STORAGE_DRIVER`.
3. Com `s3` sem `S3_BUCKET`, `S3_ACCESS_KEY` e `S3_SECRET_KEY` os uploads dão `STORAGE_NOT_CONFIGURED` em vez de irem para o disco.

## Administração (rotas `/v1/admin/*`)

A página de administração está no site (projeto `contalex-web`, em `/admin`); o backend só tem as rotas. Entra-se com uma conta normal da app que seja administradora.

**Quem é administrador?**

1. Quem tiver o email em `ADMIN_EMAILS` (no `.env`, separados por vírgulas). **Cria primeiro a tua conta na app e só depois mete lá o email**: os emails não são confirmados no registo, por isso não ponhas um email que ainda não tenha conta.
2. Quem um administrador promover (separador *Utilizadores* › *Tornar admin*), escolhendo **a que áreas acede** (`PATCH /admin/users/:id/role` com `areas`; vazio = todas). Quem está em `ADMIN_EMAILS` acede sempre a tudo. Só quem acede a tudo pode tornar outros admins, e **o primeiro administrador (o mais antigo) e os de `ADMIN_EMAILS` nunca podem ser despromovidos nem limitados por outro admin** (`ADMIN_PROTECTED`). Se perderes o acesso por engano, mete o teu email em `ADMIN_EMAILS` e reinicia o backend.

**O que lá está**

| Separador | Para quê |
|---|---|
| **Resumo** | Utilizadores, quantos têm plano pago **e porquê** (pagaram / período grátis / código / oferta / teste), receita do mês e custo da IA. |
| **Receita** | Receita por mês: bruto, reembolsos, líquido e a estimativa do que chega à conta depois da comissão da loja. Últimos pagamentos. |
| **Assinantes** | Lista de quem tem plano pago, com a origem e a coluna **"Conta para a receita?"**. |
| **Códigos promocionais** | Criar códigos (plano, duração, n.º máximo de utilizações, validade), **escolher as áreas e funcionalidades que ficam fechadas** para quem o usar, ver quem usou (plano, data de ativação, validade), desligar. |
| **Utilizadores** | Procurar pessoas e filtrar por **país, língua, plano, registo (Google ou email), aparelho, atividade e data**; **atribuir um plano sem pagamento** (a ti ou a outra pessoa), retirar, tornar admin. |
| **Países** | De onde vêm as pessoas: por país, registos recentes, ativos, planos pagos (e quem paga), Google/email, aparelho, língua e campanhas (`campaign` no registo). |
| **Bancos** | Bancos e carteiras de referência para as contas manuais (nome, país e logótipo por ficheiro ou por endereço https). São só visuais: não há ligação bancária. |
| **Feedback** | Sugestões, problemas e outras mensagens enviadas pela app, com estado e nota interna. Com `SUPPORT_EMAIL` também chegam por email. |
| **IA** | Pedidos e custo estimado do mês, por tipo e por pessoa, e o estado do teto global. |

### Receita: só conta quem pagou

Cada assinatura guarda **de onde vem**:

| Origem | Como acontece | Entra na receita? |
|---|---|---|
| `paid`: Pagou | Compra a sério na App Store / Google Play (webhook do RevenueCat com valor) | **Sim** |
| `trial`: Período grátis | Período de experiência da loja | Não (até ser cobrado) |
| `promo`: Código promocional | A pessoa escreveu um código na app (`POST /billing/redeem`) | Não |
| `grant`: Oferta | Atribuído na área de administração (ex.: a ti, o criador) ou no painel do RevenueCat | Não |
| `test`: Teste | Compras *sandbox* e `BILLING_DEV_GRANTS` | Não |

O relatório de receita sai da tabela `RevenueEvent`: uma linha por **pagamento ou reembolso** comunicado pela loja (os reembolsos entram a negativo; o mesmo evento nunca conta duas vezes). Códigos e ofertas nunca criam linhas aí, por isso podes dar Premium a quem quiseres sem estragar as contas. Os valores vêm em USD e na moeda paga, como o RevenueCat os envia; confirma os totais com o painel do RevenueCat/lojas na altura dos impostos.

---

## Entrar com o Google

A app pede à Google um *ID token* e manda-o para `POST /v1/auth/google`; o servidor confirma-o junto da Google (`google-auth-library`) e só aceita tokens emitidos para os teus IDs de cliente.

1. Na [Google Cloud Console](https://console.cloud.google.com/apis/credentials) cria as credenciais OAuth (o passo a passo está no `GOOGLE_LOGIN.md` da app).
2. No `.env`: `GOOGLE_CLIENT_IDS=<o teu Web client ID>.apps.googleusercontent.com` (podes juntar outros, separados por vírgulas). Tem de ser **o mesmo** que a app usa em `GOOGLE_SERVER_CLIENT_ID`.
3. Reinicia o servidor. Sem esta variável a rota responde `GOOGLE_NOT_CONFIGURED`.

O que acontece a quem entra com o Google:

- **Conta nova**: cria-se logo, com o nome, o email e a foto da conta Google; o username é sugerido a partir do email (pode mudar-se no perfil) e o país/moeda vêm do telemóvel. Fica sem palavra-passe (`hasPassword: false`) até definir uma.
- **Já havia uma conta com esse email**: fica ligada ao Google. Como o registo normal não confirma o email, a palavra-passe antiga deixa de servir e as outras sessões fecham-se (assim, quem tivesse criado uma conta com o email de outra pessoa perde o acesso). A resposta traz `passwordCleared: true` para a app avisar. Se o email já estava confirmado (por ter recuperado a palavra-passe com o código do email), a palavra-passe mantém-se.
- **Apagar a conta** sem palavra-passe pede um ID token novo da mesma conta Google (`POST /me/delete { idToken }`).

Se o token for recusado, o motivo fica no log do servidor (ex.: `Wrong recipient` = o client ID da app não está em `GOOGLE_CLIENT_IDS`).

---

## Premium e pagamentos (RevenueCat)

1. Cria o projeto no [RevenueCat](https://www.revenuecat.com) e liga a App Store / Google Play.
2. **Subscrições** (renovam sozinhas até a pessoa cancelar): `contalex_premium_monthly`, `contalex_premium_yearly`, `contalex_premium_plus_monthly`, `contalex_premium_plus_yearly`.
3. **Pagar uma vez** (sem renovação; na Google Play são *produtos na app* consumíveis; na App Store, *consumíveis* ou *subscrições não renováveis*): `contalex_premium_pass_month` (31 dias), `contalex_premium_pass_year` (366 dias), `contalex_premium_plus_pass_month`, `contalex_premium_plus_pass_year`. Junta-os à mesma *offering* do RevenueCat. Os dias de cada um estão na coluna `oneTimeProducts` da tabela `SubscriptionPlan` (`{ "produto": dias }`; `null` = para sempre). Podes mudar ou juntar produtos sem novo deploy.
4. Entitlements: `premium` e `premium_plus` (com os produtos respetivos; os de pagar uma vez não precisam de entitlement, o servidor conta os dias).
5. Webhook: `https://<a-tua-api>/v1/billing/webhooks/revenuecat` com um *Authorization header* à tua escolha (longo e aleatório, 32+ caracteres); o mesmo valor em `REVENUECAT_WEBHOOK_AUTH`. **É o webhook que alimenta o relatório de receita.**
6. Chave secreta (`sk_…`) em `REVENUECAT_SECRET_API_KEY`: com ela, o servidor confirma cada compra diretamente junto do RevenueCat (depois de cada webhook e quando a app chama `/billing/sync`).

### Pagar uma vez, subscrever e cancelar

- **Subscrição**: a loja cobra todos os meses/anos. **Cancelar** faz-se na loja (a app leva lá a pessoa: Google Play, Subscrições); o servidor recebe o aviso e o plano passa a `CANCELLED` com `autoRenew: false`, mas **o que já está pago continua até à data de fim**. Se a pessoa mudar de ideias antes do fim, a loja manda `UNCANCELLATION` e volta tudo ao normal.
- **Pagar uma vez**: dá os dias do produto e acaba sozinho; não há nada para cancelar. Comprar outra vez antes do fim **soma** os dias ao que ainda faltava.
- **Cobrança falhada**: o acesso mantém-se enquanto a loja der tolerância (`grace_period_expiration`); a app avisa para atualizar o pagamento. Depois disso, acaba.
- **Reembolso**: o acesso acaba logo (numa compra única, saem só os dias dessa compra) e o valor negativo entra no relatório de receita.
- `GET /me` e `GET /billing/subscription` dizem tudo o que a app precisa: `kind` (`SUBSCRIPTION` \| `ONE_TIME`), `productId`, `autoRenew`, `canCancel`, `billingIssue`, `refunded`, `expirationDate` e `locked`.

### Segurança dos pagamentos

- **A app nunca diz "paguei".** O plano só muda com um aviso do RevenueCat (webhook) ou com a resposta do RevenueCat a um pedido do próprio servidor (`REVENUECAT_SECRET_API_KEY`). `POST /billing/sync` não recebe dados nenhuns da app.
- **Webhook**: sem o *Authorization header* certo é recusado (comparação em tempo constante); cada evento só conta uma vez (`BillingEvent`), e um evento que chegue atrasado, mais antigo do que o último já aplicado, é ignorado (`ignored: "stale"`), não ressuscita um plano que entretanto acabou.
- **Dupla verificação**: depois de cada webhook o servidor pergunta ao RevenueCat o estado real dessa pessoa e acerta as assinaturas por ele: o que a loja já não reconhece (reembolsado, transferido para outra conta) deixa de dar acesso.
- **Compras únicas** só dão acesso se o produto estiver no catálogo (`oneTimeProducts`); um produto desconhecido é registado mas não dá plano. Uma compra que a confirmação junto da loja já contou não volta a somar dias quando o aviso dela chega atrasado.
- **O fim conta sempre pela data**: mesmo que um aviso se perca, um plano com a data de fim passada deixa de dar acesso nesse momento.
- **Testes**: `BILLING_DEV_GRANTS` não funciona com `NODE_ENV=production`; `BILLING_ACCEPT_SANDBOX=false` faz com que as compras de teste das lojas não deem acesso (deixa a `true` enquanto a Apple/Google estiverem a rever a app e para os teus testadores, só contas de teste criadas por ti conseguem comprar em sandbox). As compras de teste nunca entram na receita.
- **Código promocional com plano pago em vigor**: se o código dá um plano melhor, entra já (o pago continua até ao fim); se dá o mesmo ou pior, fica guardado e começa no dia em que o pago acabar (a resposta de `/billing/redeem` traz `queued`, `startsAt` e `paidRenews`: se a loja ainda vai renovar, é preciso cancelar lá para não pagar).
- **Pagamentos da app como despesa**: cada pagamento real na loja (webhook) cria uma despesa na conta da pessoa (moeda do pagamento ou primeira conta), categoria *Subscrições*, comerciante Contalexy, uma vez por evento.
- **Limites de pedidos**: `/billing/sync` (12/min) e `/billing/redeem` (8/min, para ninguém adivinhar códigos).
- Em produção, o servidor **avisa ao arrancar** se `REVENUECAT_WEBHOOK_AUTH` estiver vazio ou for curto, ou se faltar a chave secreta.

### O que fica fechado quando o plano acaba

Quem perde o plano pago (não renovou, foi reembolsado, o código promocional acabou) **não perde dados**: mas o que fez para lá dos limites do plano grátis fica **fechado**:

- **O quê**: as ferramentas de planear: objetivos, limites de gastos, planos, despesas/receitas fixas (recorrentes) e regras automáticas. Ficam abertos os mais antigos, até ao limite do plano atual; os restantes fecham. As regras automáticas são um benefício pago: sem ele, fecham todas. **Nunca fecham** contas, movimentos, empréstimos nem Spaces, é dinheiro a sério e envolve outras pessoas.
- **Amostra**: nas listas (`GET /goals`, `/budgets`, `/plans`, `/recurring`, `/rules`) os fechados vêm com `locked: true` e só um bocadinho: o nome e pouco mais (num objetivo, o valor-alvo e a percentagem; num limite, o valor; num plano, quantos itens tem). O resto vem a zeros/vazio. O histórico de preços (benefício pago) tem `GET /prices/teaser`: quantos produtos estão guardados e o nome de três.
- **Fechado é fechado**: abrir, mudar ou usar um item fechado (qualquer rota com o `:id` dele, ligar-lhe um movimento) responde `403 PLAN_ITEM_LOCKED` com `details: { limit, max, requiredPlan, locked: true }`. Também deixa de trabalhar sozinho: não cria movimentos nem depósitos automáticos, não manda lembretes nem avisos, e não aparece no Início, no calendário, no simulador nem a quem acompanha os gastos.
- **Apagar é sempre possível** (`DELETE /<coisa>/:id`) e `GET /me/export` continua a trazer tudo, os dados são da pessoa.
- **Avisos** (grupo "conta" das notificações): `subscription_ending` uns dias antes de um plano que não renova acabar (subscrição cancelada, compra única, código promocional), `subscription_ended` / `subscription_ended_locked` quando a pessoa fica sem plano (o segundo diz quantas coisas ficaram fechadas) e `subscription_billing_issue` quando a loja não consegue cobrar. Um aviso por plano; a tarefa corre de hora a hora (`JOBS_ENABLED`).
- **Volta tudo** no momento em que o plano volta: não há nada para "desbloquear" à mão. `plan.locked` (em `GET /me`) diz quantos itens estão fechados: `{ goals, budgets, plans, recurring, rules, total }`.

Os **planos, limites e benefícios** estão na tabela `SubscriptionPlan` (criada automaticamente a partir de `src/billing/plans.catalog.ts`). Para mudar um limite ou dar um benefício a outro plano, edita a linha na base de dados (ex.: `npx prisma studio`), sem novo deploy. Para criar um benefício novo: uma chave em `FEATURES` e `entitlements.assertFeature(userId, 'chave')` no serviço.

| | Grátis | Premium | Premium+ |
|---|---|---|---|
| Contas | 5 | 50 | ∞ |
| Limites de gastos (orçamentos) | 5 | 50 | ∞ |
| Objetivos ativos | 3 | 30 | ∞ |
| Planos ativos / itens por plano | 3 / 40 | 30 / 200 | ∞ / 500 |
| Spaces / membros | 2 / 6 | 10 / 30 | 30 / 100 |
| Recorrentes | 15 | 100 | ∞ |
| Empréstimos em aberto | 10 | 200 | ∞ |
| Pessoas a acompanhar os meus gastos | 2 | 10 | 30 |
| Relatórios | 3 meses | 3 anos | ∞ |
| Exportar CSV | 31 dias | ∞ | ∞ |
| **IA: perguntas ao assistente / mês** | **15** | 150 | 600 (modelo avançado) |
| **IA: documentos lidos (recibos) / mês** | **10** | 100 | 400 |
| **IA: previsões e análises completas / mês** | **4** | 30 | 120 |
| Plano do mês, simulador, análise de desperdícios (base) | sim | sim | sim |
| Simulações longas (até 36 meses, vários "e se…"), todas as observações de desperdício | não | sim | sim |
| Regras automáticas, avisos personalizados, transportar sobras, etiquetas de preço | não | sim | sim |
| Open Banking, análises avançadas, experimental | não | não | sim |

**Promoções sem spam** (tabela `Promotion`): cada promoção tem intervalo mínimo, pausa depois de fechada e máximo de visualizações; no total nunca mais do que uma por `PROMOTIONS_GLOBAL_GAP_HOURS`; nada nos primeiros 2 dias de conta, nada a quem já tem plano pago e nada durante tarefas (a app pede com `context=busy`).

## IA: usada só onde faz falta, com limites

- **Sem IA** (contas do servidor, sem custo nem limite): plano do mês, planeado vs. real, simulador, previsão do mês (`/simulator/outlook`), análise de desperdícios, alertas.
- **Com IA** (Claude): perguntas ao assistente, leitura de recibos, previsões/análises completas e planos automáticos. Cada pessoa tem **três contadores por período** (perguntas, documentos, previsões; ver tabela acima). O período **renova pelo aniversário da ativação do plano** (ou do registo, no plano grátis), não no dia 1: alguém que ativa a 15 de março tem quota de 15 de março a 15 de abril, e assim por diante (31 de janeiro → 28 de fevereiro → 31 de março, sem deslizar). Se o plano acabar antes, o período acaba com ele; um plano novo começa um período novo. Fica tudo em `UsageCounter` (pessoa, funcionalidade, período) e em `GET /ai/usage` (`periodStart`, `resetsAt`). Ao chegar ao limite a API responde `AI_QUOTA_REACHED` com `details.bucket`, `resetsAt` e o plano que dá mais.
- **Sem gastar duas vezes**: os pedidos de IA aceitam `X-Idempotency-Key`. A quota é reservada antes de chamar o modelo (duas chamadas ao mesmo tempo nunca passam do limite) e devolvida se a chamada falhar; repetir um pedido com a mesma chave devolve a mesma resposta sem contar nem custar outra vez. A app manda uma chave em cada pedido.
- **Plano grátis**: só tem o básico da IA (perguntas e algumas previsões, com os números da tabela `SubscriptionPlan`, que se podem mudar sem novo deploy). Ler recibos, ler etiquetas, importação inteligente e o resto do avançado são dos planos pagos; o WhatsApp é do Premium+. As restrições estão no servidor (`assertFeature`), não só na app.
- **Teto global**: `AI_MONTHLY_BUDGET_USD` (0 = sem teto). O custo é estimado pelos tokens de cada pedido e pelos preços em `AI_PRICE_*`. A **80%** do teto as previsões/análises ficam em pausa para o plano grátis; a **100%** fica toda a IA em pausa para o plano grátis (`AI_BUDGET_REACHED`). Quem paga não é afetado (tem os seus próprios limites). Vê o estado no site, em `/admin` › IA.
- Sem `ANTHROPIC_API_KEY`, as funções de IA respondem "ainda não disponível" e o resto da app funciona normalmente.
- Ordem de grandeza: com o modelo por defeito, uma pergunta ao assistente custa menos de 1 cêntimo de dólar, por isso alguém no plano grátis que gaste os três contadores todos fica na casa dos 10-25 cêntimos por mês. Com muitos utilizadores isto soma: define o teto antes de lançar e acompanha o custo real no site, em `/admin` › IA (os preços dos modelos mudam: confirma-os e ajusta `AI_PRICE_*`).

## Idiomas

Há PT/EN/FR/DE (o que não existir cai para inglês). As mensagens de erro saem na língua do pedido (`Accept-Language`). Notificações push, emails e CSV saem na língua guardada na conta de quem os recebe (`user.language`), formatando valores e datas à maneira dessa pessoa; a app mantém essa língua igual à do telemóvel, ou à escolhida nas definições. Um convite por email a quem ainda não tem conta vai na língua de quem convida. O teste `src/notifications/notifications.language.spec.ts` confirma isto e falha se algum aviso ficar sem texto numa das línguas. Para um idioma novo: acrescenta-o em `src/common/i18n/messages.ts` (`SUPPORTED_LANGUAGES` + textos).

---

## API (resumo)

Todas as rotas em `/v1`, com `Authorization: Bearer <accessToken>` (exceto as públicas). Respostas `{ success, data, meta? }`; erros `{ success: false, error: { code, message, details? } }`: a app reage ao `code` (ex.: `PREMIUM_REQUIRED` abre a explicação do Premium com `details.feature`; `PLAN_ITEM_LOCKED` diz que o item está fechado por falta do plano).

| Área | Rotas |
|---|---|
| Sessão (públicas) | `POST /auth/register` (com `birthDate` AAAA-MM-DD, 13 a 120 anos; `GET /me` devolve `birthDate` e `PATCH /me` muda-a), `POST /auth/login`, `POST /auth/google` (entrar/criar conta com o Google: `{ idToken, country?, language?, timezone? }`), `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /auth/username-available` |
| Listas (públicas) | `GET /meta/countries`, `GET /meta/currencies`, `GET /meta/languages`, `GET /billing/plans` |
| Perfil | `GET/PATCH /me` (inclui `isAdmin`, `hasPassword`, `googleLinked` e o plano: `plan.source`, `kind`, `canCancel`, `billingIssue`, `refunded`, `locked`), `POST /me/onboarding`, `POST/DELETE /me/avatar`, `POST /me/password`, `POST /me/delete` (**pedido**: a conta só é apagada 30 dias depois; entrar de novo cancela), `GET /me/export`, `POST/DELETE /me/push-tokens` |
| **Segurança** | `GET /me/logins` (sessões abertas + histórico de entradas, com as tentativas falhadas), `DELETE /me/sessions/:sessionId`, `POST /me/sessions/revoke-others` |
| **Pessoas** | `GET /users/lookup?username=`, `GET /users/search?q=` (quem já conheço + um @username exato), `GET /users/:id` (perfil e o que temos em comum), `GET /me/requests` (convites, empréstimos e planos à espera de resposta) |
| Contas | `GET/POST /accounts`, `GET/PATCH/DELETE /accounts/:id` (`?force=true` apaga com os movimentos), `POST /accounts/:id/adjust`, `GET /accounts/:id/history`, `POST /accounts/reorder` |
| Categorias | `GET/POST /categories`, `PATCH/DELETE /categories/:id` (`?moveTo=`), `POST /categories/restore-defaults` |
| Movimentos | `GET/POST /transactions`, `GET/PATCH/DELETE /transactions/:id`, `POST /transactions/:id/duplicate`, `GET /transactions/summary`, `GET /transactions/export` (CSV), `GET /transactions/suggest`, `GET /transactions/descriptions`, `GET /transactions/tags`, `GET/POST/DELETE /transactions/saved-filters` |
| Filtros | `type`, `accountIds`, `categoryIds` (`none` = sem categoria), `tags`, `from`, `to`, `minAmount`, `maxAmount`, `q`, `hasAttachment`, `planId`, `recurringOnly`, `sort`, `limit`, `offset` (listas separadas por vírgulas) |
| Ficheiros | `POST /attachments` (multipart `file`), `DELETE /attachments/:id`, `GET /files/:id` |
| Recorrentes | `GET/POST /recurring`, `PATCH/DELETE /recurring/:id`, `GET /recurring/upcoming?days=`, `POST /recurring/:id/pay`, `POST /recurring/:id/skip` |
| **Plano do mês** | `GET /monthly-plans?limit=` (histórico, até 120 meses; cada um com `isPast` e `linesCount`), `GET /monthly-plans/current` (o plano ou uma sugestão), `GET/PUT/DELETE /monthly-plans/:AAAA-MM`, `POST /monthly-plans/:AAAA-MM/copy-previous`, `POST /monthly-plans/:AAAA-MM/copy-from/:AAAA-MM` (reutilizar um plano antigo), `PATCH /monthly-plans/:AAAA-MM/lines/:lineId` (`list: true\|false\|null`: esta linha tem "o que vou comprar"?) |
| **Limite do dia** | `GET /daily-limit` (`?week=true` junta os últimos 7 dias, `?suggest=true` o que o plano do mês deixa gastar por dia), `PUT /daily-limit` (`amount` ou `null` para tirar; `onlyToday: true` vale só para hoje) |
| **Planos do mês enviados** | `GET /plan-offers`, `POST /plan-offers` (enviar o meu plano de um mês, o atual ou um antigo: `periodKey`, `username`\|`userId`, `note?`, `includeIncome?`), `GET /plan-offers/:id`, `POST /plan-offers/:id/accept` (`periodKey?`), `POST /plan-offers/:id/decline`, `DELETE /plan-offers/:id` |
| **Envios** (objetivos, planos e limites como modelo) | `GET /offers` (`received`, `sent`, `pendingCount`), `POST /offers` (`kind: GOAL\|PLAN\|BUDGET`, `itemId`, `username`\|`userId`, `note?`), `GET /offers/:id` (o molde e o que quem recebe pode escolher: datas propostas, 12 meses, categorias que tem), `POST /offers/:id/accept` (`name?`, `startDate?`, `targetDate?`, `periodKey?`), `POST /offers/:id/decline`, `DELETE /offers/:id` |
| Limites (orçamentos) | `GET/POST /budgets`, `GET/PATCH/DELETE /budgets/:id`, `GET /budgets/:id/history` |
| Objetivos | `GET/POST /goals` (`startDate`, `targetDate`, `steps[]`), `GET/PATCH/DELETE /goals/:id` (`pinned`; o detalhe traz `steps`, `deposits`, `plannedMonthly`, `plannedDate`, e ainda `notStarted`, `daysLeft`, `timePercent`, `expectedSaved`), `POST /goals/:id/contributions`, `DELETE /goals/:id/contributions/:cid` |
| **Objetivos específicos** | `POST /goals/:id/steps` (`title`, `amount?`, `dueDate?`, `done?`), `PATCH/DELETE /goals/:id/steps/:stepId` (`sortOrder` para reordenar) |
| **Depósitos planeados** | `POST /goals/:id/deposits` (`amount`, `date`, `frequency` ONCE/WEEKLY/MONTHLY, `endDate?`, `autoApply?`, `note?`), `PATCH/DELETE /goals/:id/deposits/:depositId`, `POST …/confirm` ("depositei"), `POST …/skip`, `GET /goals/deposits/upcoming?days=` |
| Planos | `GET/POST /plans` (`?period=AAAA-MM`; `periodKey`, `categoryId`), `GET/PATCH/DELETE /plans/:id` (`pinned`, `capital`), `POST /plans/:id/duplicate` (`periodKey?` = copiar para outro mês), `POST /plans/:id/checkout` ("fiz as compras": valores reais + uma despesa), `POST /plans/:id/items`, `PATCH/DELETE /plans/:id/items/:itemId` (`kind`, `actualAmount`; `quantity` + `unitPrice` dão o total da linha em `estimatedAmount`), `POST /plans/:id/items/:itemId/pay` |
| **Empréstimos** | `GET /loans?status=open\|closed\|all`, `POST /loans`, `GET/PATCH/DELETE /loans/:id` (`pinned`, `status: CANCELLED`), `POST /loans/:id/payments`, `DELETE /loans/:id/payments/:pid`, **ligados a outra pessoa**: `counterpartUsername`\|`counterpartId` ao criar, `POST/DELETE /loans/:id/link`, `POST /loans/:id/accept` (`accountId?`), `POST /loans/:id/decline` (a lista traz `requests`; os dois veem o mesmo empréstimo e as devoluções) |
| **Simulador** (sem IA) | `GET /simulator/outlook`, `POST /simulator/purchase`, `POST /simulator/goal`, `POST /simulator/forecast` |
| **Desperdícios** (sem IA) | `GET /insights/waste` |
| **Acompanhamento** | `GET /sharing`, `POST /sharing/invitations` (`sections?`, `hiddenCategoryIds?`, `manage?`), `PATCH /sharing/:id` (`scope?`, `sections?`, `hiddenCategoryIds?`, `manage?`), `DELETE /sharing/:id`, `POST /sharing/:id/accept\|decline`, `GET /sharing/:id/overview?month=`, `GET /sharing/:id/history` (os planos dos meses passados), `GET /sharing/:id/transactions` (precisa da secção `transactions`; filtros `month` ou `from`/`to`, `categoryId`, `type`, `q`, `minAmount`, `maxAmount`, `limit`, `offset`), `GET/POST /sharing/:id/notes`, `DELETE /sharing/:id/notes/:nid`, `POST /sharing/:id/plan-proposal` (quem acompanha propõe um plano do mês), `GET /sharing/:id/activity` (o que quem ajuda a gerir mudou) |
| **Ajudar a gerir** | As rotas normais (objetivos, limites, limite do dia, plano do mês, planos, despesas fixas, movimentos, e as listas de categorias e contas) com o cabeçalho `X-Contalex-Help: <id do acesso>`: o pedido é feito na conta de quem partilha. Só passam as rotas marcadas com `@Help` e só nas áreas de `manage` |
| **Lembretes** | `POST /loans/:id/nudge` (`message?`; empréstimo ligado, um por dia de cada lado), `POST /spaces/:id/balances/remind` (`userId` de quem me deve; um por dia) |
| Spaces | `GET/POST /spaces`, `POST /spaces/join`, `GET/PATCH/DELETE /spaces/:id` (privilégios, só o dono: `inviteBy`, `expensesBy`, `editBy`; a resposta traz `settings` e `can`), `POST /spaces/:id/leave`, `POST /spaces/:id/invite-code`, `POST /spaces/:id/invitations`, `DELETE /spaces/:id/invitations/:iid`, `PATCH/DELETE /spaces/:id/members/:userId`, `GET/POST /spaces/:id/expenses`, `GET/PATCH/DELETE /spaces/:id/expenses/:eid`, `GET /spaces/:id/balances`, `POST /spaces/:id/settlements`, `DELETE /spaces/:id/settlements/:sid`, `GET /spaces/:id/activity` (inclui `kind: log`, quem mudou ou apagou o quê, e `kind: deposit`), `GET /space-invitations`, `POST /space-invitations/:id/accept`, `POST /space-invitations/:id/decline` |
| **Plano em grupo** (num Space) | `GET /spaces/:id/fund` (o fundo comum: saldo, livre, guardado para metas, a parte de cada um, metas e últimos movimentos), `GET /spaces/:id/deposits`, `POST /spaces/:id/deposits` (`amount`, `goalId?`, `accountId?` + `categoryId?` para registar também na conta pessoal), `POST /spaces/:id/withdrawals` (`amount`, `accountId?`), `DELETE /spaces/:id/deposits/:depositId`, `POST /spaces/:id/goals`, `PATCH/DELETE /spaces/:id/goals/:goalId` (`status: ARCHIVED` = usar o dinheiro; `ACTIVE` = reabrir), `GET/PUT /spaces/:id/plan?month=AAAA-MM` (quanto se quer gastar por categoria vs. as despesas), despesas com `fromPot: true` são pagas com o fundo |
| **Mensagens** | `GET /chats` (todas as conversas, com a última mensagem e as por ler), `GET /chats/unread`, `GET/POST /spaces/:id/messages` (a conversa do Space), `GET/POST /chats/direct/:userId` (a dois, só entre quem já tem algo em comum), `DELETE /chats/messages/:id`: as listas aceitam `after=<ISO>` (só as novas, para ir atualizando), `before=<ISO>` (as mais antigas) e `limit` |
| Painel e relatórios | `GET /dashboard` (inclui `monthlyPlan`, `dailyLimit`, `loans`, `sharing`), `GET /periods`, `GET /reports/overview`, `GET /reports/trend`, `GET /reports/net-worth`, `GET /reports/merchants`, `GET /reports/tags`, `GET /calendar?month=` (por dia: movimentos, receitas/despesas fixas, depósitos planeados, entradas em objetivos, empréstimos, datas e itens de planos) |
| Notificações | `GET /inbox` (o que há por ver: `notifications`, `messages` e o aviso mais recente em `latest`), `GET /notifications` (sem as mensagens), `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `DELETE /notifications/:id` |
| Premium | `GET /billing/plans` (pública; inclui `productIds` e `oneTimeProducts`), `GET /billing/subscription`, `POST /billing/sync` (confirma junto da loja; devolve o plano e `managementUrl`, a página da loja para gerir/cancelar), **`POST /billing/redeem`** (código promocional), `POST /billing/dev/grant`, `POST /billing/webhooks/revenuecat`, `GET /promotions/next?placement=`, `POST /promotions/:key/seen\|dismiss\|click` |
| IA | `GET /ai/usage`, `POST /ai/chat`, **`POST /ai/forecast`**, `POST /ai/insights`, `POST /ai/plan`, `POST /ai/scan/receipt`, `POST /ai/scan/price` |
| Preços | `GET/POST /prices`, `GET /prices/history?name=`, `GET /prices/teaser` (amostra para quem não tem o plano), `DELETE /prices/:id` |
| Regras | `GET/POST /rules`, `PATCH/DELETE /rules/:id`, `POST /rules/apply` |
| **Administração** (só admins) | `GET /admin/overview`, `GET /admin/revenue?months=&sandbox=`, `GET /admin/payments`, `GET /admin/subscribers?kind=&q=`, `GET /admin/users?q=`, `POST/DELETE /admin/users/:id/grant`, `PATCH /admin/users/:id/role`, `GET/POST /admin/promo-codes`, `PATCH/DELETE /admin/promo-codes/:id`, `GET /admin/promo-codes/:id/redemptions`, `GET /admin/ai` |
| Câmbios | `GET /exchange/rates?base=` |
| Saúde | `GET /health` |

### Como funcionam as partes novas

- **Plano do mês**: rendimento previsto − despesas previstas (por categoria) − objetivos − poupança = dinheiro livre. Durante o mês cada linha mostra planeado vs. real; ao passar o planeado numa categoria sai **um** aviso (não um por despesa).
- **Empréstimos**: "emprestei" (devem-me) e "pedi emprestado" (devo), com data para devolver, devoluções em partes e lembretes: X dias antes (à escolha, ex.: 7 e 1), no dia e depois de passar a data (1, 3, 7, 14, 30 dias; depois de 14 em 14). Nunca de madrugada, cada aviso uma só vez. `pinned` fixa o empréstimo no Início. Os movimentos criados nas contas ficam fora dos relatórios (emprestar não é uma despesa).
- **Simulador**: `purchase`: saldo disponível + receitas previstas − despesas previstas − poupança planeada − compra = o que sobra, com veredicto (`OK`, `TIGHT`, `AFFECTS_GOALS`, `NOT_AFFORDABLE`), "e se for daqui a X meses?", "e se guardar Y por mês?" e a projeção de 12 meses. `goal`: quanto tempo, data prevista, quanto guardar por mês, cenários e despesa inesperada. Os números vêm do plano do mês; sem plano, da média dos últimos 3 meses; sem histórico, dos pagamentos fixos (`basis` diz qual).
- **Acompanhamento**: convidas alguém (username ou email) para **ver** os teus gastos de cada mês: totais, categorias, plano e limites; a lista de movimentos só se escolheres a partilha "completa". Nunca saldos nem nomes de contas, só leitura, e podes parar quando quiseres. A pessoa pode deixar notas.
- **Ajudar a gerir**: quem partilha escolhe, área a área, onde quem acompanha também pode criar e alterar (`manage`: `goals`, `budgets`, `plan`, `plans`, `recurring`, `transactions`). A app de quem ajuda usa os ecrãs normais com o cabeçalho `X-Contalex-Help`; o `HelpGuard` (depois do `JwtAuthGuard`) confirma o acesso e passa o pedido para a conta de quem partilha, guardando quem ajudou. Regras: ajudar numa área mostra-a; o plano do mês e as despesas fixas mostram também o que entra; com categorias reservadas não há ajuda (`SHARE_HELP_NEEDS_ALL`); sem o que entra à vista, quem ajuda não mexe em receitas; as contas veem-se sem saldos. Cada alteração fica em `SharedActivity` e quem partilha recebe um aviso (`help_change`; os seguidos juntam-se num só até o abrir).
- **Lembretes**: num empréstimo ligado, quem emprestou lembra quanto falta (`loan_nudge`) e quem pediu emprestado manda notícias (`loan_note`), com uma frase opcional. Num Space, lembra-se quem deve pelos acertos sugeridos (`space_reminder`). Tudo na língua de quem recebe.
- **Perfis**: `bio` ("sobre mim", até 160 caracteres) em `PATCH /me`; `GET /users/:id` traz também `bio` e, em `sharing`, `iCanHelp`/`theyCanHelp`.
- **Códigos com áreas fechadas**: um código promocional pode fechar áreas (`blockedAreas`: spaces, loans, sharing, plans, goals, budgets, recurring, simulator, ai, prices, rules, reports, chat, offers, shopping, investments, import, whatsapp) e funcionalidades (`blockedFeatures`, chaves do catálogo). Quem só tem o plano por esse código vê `plan.blockedAreas` em `GET /me` (a app esconde as áreas) e o `AreaGuard` recusa as rotas com `AREA_BLOCKED`. Mudar o código aplica-se logo a quem já o usou; um acesso ao mesmo plano pela loja ou por oferta abre tudo. Cada utilização fica em `PromoRedemption` com plano, data de ativação e validade.
- **Privilégios dos grupos**: por papel, `Space.privileges` = `{ ADMIN: {…}, MEMBER: {…} }` com `invite`, `addExpense`, `editOwn`, `editAny`, `fund`, `goals`, `plan`, `chat`, `manageMembers`. Só o dono muda (`PATCH /spaces/:id` com `privileges`); o dono pode sempre tudo. As colunas antigas (`inviteBy`, `expensesBy`, `editBy`) continuam a contar para quem nunca gravou a matriz e são derivadas dela depois. `GET /spaces/:id` devolve `privileges` e o `can` já calculado.
- **Listas de compras**: são planos do tipo `SHOPPING` (`GET /plans?type=SHOPPING`). Itens com quantidade e preço opcional; `isDone` marca o que já se comprou; `POST /plans/:id/checkout` recebe o que se pagou por item e, se o recibo for diferente, `total`; `close: true` fecha a lista. No plano, `estimated` é a soma dos itens e `spent` o que se pagou de facto; os itens ficam no movimento (`items`).
- **Bancos de referência**: `GET /meta/institutions?country=PT` (os do país primeiro). Uma conta pode ter `institutionId`; o logótipo vem desta lista.
- **Feedback**: `POST /feedback` (`kind`: SUGGESTION | PROBLEM | OTHER, `message`, `appVersion`, `platform`; até 10 por dia) e `GET /feedback` (os meus). Na administração: `GET /admin/feedback`, `PATCH /admin/feedback/:id` (`status`, `adminNote`).
- **Ficheiros no DigitalOcean Spaces** (`STORAGE_DRIVER=s3`): os recibos ficam privados e `GET /files/:id` responde com um redirecionamento para um endereço temporário (`S3_SIGNED_SECONDS`); `GET /files/:id/url` dá o endereço à app. Fotos de perfil e logótipos ficam públicos (CDN em `S3_PUBLIC_URL`). Sem Spaces, tudo continua no disco.
- **Redis** (`REDIS_URL`): limites de pedidos contados entre servidores, limite curto de IA, cadeados dos webhooks e a memória de idempotência. Sem Redis fica tudo em memória (chega para um só processo).
- **Limites de pedidos**: 240 por minuto por IP no geral, e limites próprios em entrar/registar (10/min), ficheiros (20/min), convites e pedidos a outras pessoas (15/min), pesquisas (90/min), exportações (10/min). Uma conta com 8 tentativas falhadas em 15 minutos fica bloqueada esses minutos (`LOGIN_LOCKED`), além do limite por IP.
- **IA, limite curto e créditos**: além da quota do período há um limite por janela de minutos (`AI_BURST_*`), que renova sozinho; passar dele dá `AI_RATE_LIMIT` (429) com `details.retryAfterSeconds`. Quando a quota do período acaba, gastam-se **créditos** comprados na loja (compra única; `AI_CREDIT_PRODUCTS`, via webhook do RevenueCat, uma vez por evento) ou oferecidos (`POST /admin/users/:id/credits`). `GET /billing/credits` dá saldo, pacotes e histórico; `GET /ai/usage` traz `credits` e `burst`.
- **Idempotência geral**: qualquer POST/PUT/PATCH com `X-Idempotency-Key` devolve a mesma resposta durante 24 h (por pessoa e chave). É o que deixa a app repetir pedidos sem rede sem criar duplicados.
- **Pagamentos**: além dos webhooks com `BillingEvent` (cada evento uma vez), há uma reconciliação diária (05:25) das assinaturas pagas não confirmadas há mais de um dia, lida ao RevenueCat de servidor para servidor. `GET /billing/methods?country=BR&platform=android` lista, só para informar, as formas de pagamento da loja nesse país (cartão, débito, Pix, boleto, operadora...). Quem cobra é sempre a loja.
- **Calculadora**: `POST /simulator/savings` (inicial, mensal, taxa anual, meses, meta, imposto, subida anual) faz as contas de poupança mês a mês, sem IA.
- **Investimentos**: `/investments` (CRUD, valor atualizado à mão), dividendos recebidos (podem entrar como receita numa conta) e previstos (`POST /investments/:id/dividends/project`), `GET /investments/dividends?months=12` por mês com recebidos vs previstos.
- **Importar CSV/XLSX**: `POST /import/preview` (multipart `file`) lê o ficheiro, adivinha as colunas (data, valor ou débito/crédito, descrição) e assinala duplicados (mesma data, valor e descrição); `POST /import/:id/mapping` muda o mapeamento; `POST /import/:id/mapping/ai` pede à IA (planos pagos, conta como pergunta) só quando o normal não chega; `POST /import/:id/commit` cria os movimentos (etiqueta `importado`).
- **WhatsApp** (Meta Cloud API, Premium+): `GET /whatsapp` (estado), `POST /whatsapp/link` dá um código de 15 minutos que a pessoa manda por WhatsApp para `WHATSAPP_BUSINESS_NUMBER`; a partir daí, "12,50 café" ou a foto de uma fatura viram um `PendingTransaction` (push `whatsapp_pending`) que a pessoa confirma em `POST /pending-transactions/:id/confirm` (ou descarta). Webhook em `/v1/whatsapp/webhook` (GET de verificação com `WHATSAPP_VERIFY_TOKEN`; POST assinado com `X-Hub-Signature-256` e `WHATSAPP_APP_SECRET`), cada mensagem tratada uma só vez. **Falta**: criar a app na Meta (WhatsApp Business), o número, o token permanente e pôr as credenciais no `.env`.
- **Origem do registo**: `signupPlatform` (android | ios | web | app, pelo navegador) e `campaign` (opcional no registo) ficam na conta e aparecem em `/admin/users` e `/admin/countries`.
- **Fixar**: objetivos, planos e empréstimos com `pinned: true` aparecem primeiro nas listas e no Início.
- **Plano em grupo**: cada Space tem um **fundo comum**: cada pessoa põe dinheiro (e, se quiser, o depósito sai logo da sua conta pessoal como despesa), o grupo paga despesas com o fundo (`fromPot`: não criam dívidas entre as pessoas) e junta para **metas** em conjunto. Contas: `saldo = depósitos − levantamentos − despesas do fundo`; o que está numa meta aberta fica **guardado** (`earmarked`) e só o resto (`free`) se gasta ou levanta. A parte de cada um (`stake`) é o que pôs − o que tirou − a sua parte das despesas do fundo; só se levanta até aí, e só se sai do Space com ela a zero. Fechar uma meta (`ARCHIVED`) devolve o dinheiro ao fundo livre. O **plano de gastos** do grupo compara o que se quer gastar em cada categoria com as despesas (do mês pedido, ou de sempre, como numa viagem).
- **Limite do dia**: "hoje podes gastar X, faltam Y". Há um limite de todos os dias (fica na conta) e, se a pessoa quiser, um limite só para hoje. Contam as despesas do dia menos as fixas (renda, mensalidades): o limite é para o que se decide no dia. Avisa aos 80% e ao chegar ao limite, cada aviso uma vez por dia; mudar o limite recomeça a contagem dos avisos. Sem limite, `suggest` propõe o que o plano do mês deixa gastar por dia.
- **Total das linhas**: num plano, cada item pode ter `quantity` e `unitPrice`; o servidor guarda o total em `estimatedAmount` (quantidade × preço). Dar só o total apaga o preço por unidade; mudar só a quantidade refaz o total.
- **"O que vou comprar" por linha**: no plano do mês, cada linha de categoria diz em `canList` se mostra a lista de compras. À partida as mensalidades e os transportes não mostram; a pessoa liga ou desliga linha a linha (`list`), e `null` volta ao automático. A escolha mantém-se quando o plano é guardado outra vez ou copiado.
- **Planos antigos**: o histórico guarda os planos de todos os meses. Um plano antigo pode voltar a usar-se (`copy-from`) ou enviar-se a outra pessoa (`POST /plan-offers` com o `periodKey` desse mês); quem recebe escolhe um dos próximos 12 meses.
- **Envios**: um objetivo, um plano ou um limite de gastos pode enviar-se a outra pessoa como modelo. Vai só o molde: nunca o dinheiro guardado, os movimentos, as contas ou os valores reais. Quem aceita fica com uma cópia sua e ajusta o que quiser: o nome, as datas (os objetivos específicos acompanham o novo início), o mês do plano. Os valores são convertidos para a moeda de quem recebe; um limite usa as categorias de quem recebe (as que não tiver ficam de fora, e se não tiver nenhuma o envio não pode ser aceite). Conta para os limites do plano de quem aceita.
- **Objetivos com início e fim**: `startDate` e `targetDate` marcam o caminho; `timePercent` e `expectedSaved` dizem onde se devia estar hoje. Dentro do objetivo há **objetivos específicos** (`steps`): partes do caminho com nome e, se a pessoa quiser, valor e data. `covered` diz que o que já está guardado chega para esse passo e para os anteriores; `overdue`, que a data passou sem estar feito. Encurtar o objetivo puxa para o novo fim os passos que ficavam depois dele.
- **Acompanhamento à medida**: quem partilha escolhe as secções que mostra (`income`, `plan`, `budgets`, `goals`, `transactions`, `plans`, `recurring`) e as categorias que ficam de fora de tudo (`hiddenCategoryIds`, "mostrar tudo exceto"). Quem acompanha vê os planos dos meses passados (`history`), pode abrir qualquer mês e filtrar os movimentos. Sabe que há coisas reservadas (`partial`), mas não quais. Os acessos que já existiam continuam a mostrar exatamente o que mostravam.
- **Avisos e mensagens por ver**: `GET /inbox` devolve quantos avisos e quantas mensagens estão por ver e o aviso mais recente. A app pede-o de poucos em poucos segundos para mostrar os contadores e um aviso no ecrã quando chega algo novo, mesmo sem notificações push. As mensagens contam-se à parte e não entram na lista dos avisos; abrir a conversa ou a lista dá-as por vistas.
- **Mensagens**: mensagens curtas (até 1000 caracteres) na conversa de cada Space e a dois. Não há WebSockets: a app pede "só as novas" (`after`) de poucos em poucos segundos enquanto a conversa está aberta. Abrir a conversa dá-a por lida. Os avisos juntam-se **um por conversa** (com `count`), em vez de um por mensagem; o push respeita a preferência `messages`. Apagar uma mensagem tira o texto da base de dados e deixa só o lugar; ao apagar a conta, vão as mensagens que a pessoa escreveu e as conversas a dois em que estava.

Câmbios: [ExchangeRate-API](https://www.exchangerate-api.com) (open.er-api.com), atualizados todos os dias.
f