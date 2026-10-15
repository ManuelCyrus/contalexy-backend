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
    // As migrações usam a ligação direta (DIRECT_URL) quando a base é gerida por um
    // serviço com "pooler" (Neon, Supabase...); a app usa sempre a DATABASE_URL.
    url: process.env.DIRECT_URL || env('DATABASE_URL'),
  },
});
