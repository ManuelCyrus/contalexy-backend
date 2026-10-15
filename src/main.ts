import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { join, resolve } from 'path';
import { mkdirSync } from 'fs';
import { env, loadEnv } from './config/env';
import { DatabaseNotReadyError } from './database/prisma.service';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

async function bootstrap() {
  loadEnv(); // falha logo com uma mensagem clara se faltar alguma coisa no .env
  const config = env();
  // Só depois de o .env estar validado é que se carrega a aplicação (há módulos
  // que leem a configuração ao serem importados).
  const { AppModule } = await import('./app.module');
  // abortOnError: false → um erro de arranque chega ao `catch` lá em baixo (mensagem limpa).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, abortOnError: false });

  // Atrás de um proxy (Railway, Render, Nginx) o IP real vem no X-Forwarded-For.
  app.set('trust proxy', 1);
  // Corpos pequenos (os ficheiros vão em multipart, com o seu próprio limite).
  // O corpo cru fica guardado para confirmar assinaturas de webhooks (WhatsApp).
  app.use(json({ limit: '1mb', verify: (req, _res, buf) => ((req as unknown as { rawBody?: Buffer }).rawBody = buf) }));
  app.use(urlencoded({ extended: false, limit: '256kb' }));
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Sem "upgrade-insecure-requests": em desenvolvimento tudo corre em http://localhost.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.useBodyParser('json', { limit: '2mb' });
  app.enableCors({
    origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('v1');
  app.use(new RequestIdMiddleware().use);

  // Fotos de perfil (públicas), só quando os ficheiros ficam no disco. Com
  // STORAGE_DRIVER=s3 nada é escrito no servidor: vai tudo para o bucket.
  // Os recibos NÃO estão aqui — só por /v1/files/:id.
  if (config.STORAGE_DRIVER === 'local') {
    const avatars = resolve(join(config.UPLOADS_DIR, 'avatars'));
    mkdirSync(avatars, { recursive: true });
    app.useStaticAssets(avatars, { prefix: '/public/avatars', maxAge: '7d' });
  }

  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  console.log(`Contalexy API a correr em http://localhost:${config.PORT}/v1`);
  if (config.NODE_ENV === 'production' && config.BILLING_ACCEPT_SANDBOX === 'true') console.warn('Atenção: BILLING_ACCEPT_SANDBOX=true em produção. Compras de teste dão acesso ao Premium; volta a false depois da revisão da Apple.');
  console.log(config.STORAGE_DRIVER === 's3' ? `Ficheiros: S3 (bucket ${config.S3_BUCKET}${config.S3_ENDPOINT ? `, ${config.S3_ENDPOINT}` : ''})` : `Ficheiros: disco local (${resolve(config.UPLOADS_DIR)})`);
}

bootstrap().catch((err: unknown) => {
  // Problemas esperados no arranque (base de dados por preparar, .env incompleto):
  // mostra-se só a mensagem, que diz o que fazer.
  const expected = err instanceof DatabaseNotReadyError || (err instanceof Error && err.message.startsWith('Configuração inválida'));
  console.error(expected ? `\n${(err as Error).message}` : err);
  process.exit(1);
});
