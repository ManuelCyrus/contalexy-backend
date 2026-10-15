import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// O Prisma 7 lê a ligação à base de dados daqui (já não do schema).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
