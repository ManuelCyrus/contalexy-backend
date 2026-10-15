import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '../generated/prisma/client';
import { env } from '../config/env';

/// Prisma 7: o cliente fala com o PostgreSQL através do adaptador `pg`
/// (sem binários nativos).
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: env().DATABASE_URL }) });
  }

  async onModuleInit() {
    await this.$connect();
    await this.assertMigrated();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /// Sem as tabelas (ou com uma atualização por aplicar) o servidor arrancava
  /// e depois cada pedido dava um erro estranho. Assim pára logo, com o
  /// comando certo na mensagem.
  private async assertMigrated() {
    try {
      await this.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      // O Prisma embrulha o motivo num texto comprido: fica só o essencial.
      const message = (err as Error).message;
      const reason = /Message: `([^`]+)`/.exec(message)?.[1] ?? message.trim().split('\n').pop();
      throw new DatabaseNotReadyError(
        `Não foi possível ligar à base de dados: ${reason}\n\n  Confirma o DATABASE_URL no .env e que o PostgreSQL está a correr (ex.: docker compose up -d).\n`,
      );
    }
    const missing = await pendingMigrations(this);
    if (!missing) return;
    const what = missing.applied === 0
      ? 'A base de dados ainda não tem as tabelas.'
      : `A base de dados tem ${missing.names.length} atualização(ões) por aplicar: ${missing.names.join(', ')}.`;
    throw new DatabaseNotReadyError(`${what}\n\n  Corre:  npx prisma migrate deploy\n\n  (a primeira vez, com os dados de demonstração:  npm run db:setup)\n`);
  }
}

/// A base de dados não está pronta para o servidor arrancar (o texto diz o que fazer).
export class DatabaseNotReadyError extends Error {}

/// As pastas de prisma/migrations que ainda não foram aplicadas nesta base de
/// dados (null = está tudo em dia, ou não dá para saber).
export async function pendingMigrations(
  db: Pick<PrismaClient, '$queryRawUnsafe'>,
  dir: string = join(process.cwd(), 'prisma', 'migrations'),
): Promise<{ names: string[]; applied: number } | null> {
  if (!existsSync(dir)) return null;
  const expected = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!expected.length) return null;

  let applied: string[];
  try {
    const rows = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    applied = rows.map((row) => row.migration_name);
  } catch {
    // Não há registo de migrações. Se as tabelas existem na mesma, foram
    // criadas de outra forma (`prisma db push`): não há nada a comparar.
    const [{ exists }] = await db.$queryRawUnsafe<Array<{ exists: boolean }>>(`SELECT to_regclass('public."User"') IS NOT NULL AS "exists"`);
    if (exists) return null;
    applied = [];
  }
  const names = expected.filter((name) => !applied.includes(name));
  return names.length ? { names, applied: applied.length } : null;
}
