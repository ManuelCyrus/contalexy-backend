# Imagem de produção do backend. Na VPS usa-se com deploy/deploy.sh (ver deploy/README.md).
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://x:y@localhost:5432/z npm ci
COPY . .
RUN DATABASE_URL=postgresql://x:y@localhost:5432/z npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
EXPOSE 3000
# O Docker sabe se a API está bem (o deploy também verifica antes de mudar o tráfego).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-3000}/v1/health > /dev/null || exit 1
# As migrações correm no deploy (uma vez, antes de arrancar a versão nova), não aqui:
# assim duas versões a correr ao mesmo tempo nunca as aplicam em paralelo.
CMD ["node", "dist/main"]
