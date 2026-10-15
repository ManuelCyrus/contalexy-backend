# Imagem de produção do backend (ex.: Railway, Render, Fly.io, VPS)
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://x:y@localhost:5432/z npm ci
COPY . .
RUN DATABASE_URL=postgresql://x:y@localhost:5432/z npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
# Página da área de administração (/admin)
COPY --from=build /app/public ./public
EXPOSE 3000
# Aplica as migrações e arranca
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
