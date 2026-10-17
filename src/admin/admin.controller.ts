import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { PromoService } from '../billing/promo.service';
import { CreditsService } from '../billing/credits.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { InstitutionsService, institutionSchema } from '../institutions/institutions.service';
import { FeedbackService, feedbackUpdateSchema } from '../feedback/feedback.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadedFileLike } from '../storage/storage.service';
import { env } from '../config/env';
import { ADMIN_AREAS } from '../common/utils/admin';

const days = z.number().int().min(1).max(3650);
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date');

const grantSchema = z.object({
  plan: z.string().trim().min(1).max(30),
  /// Vazio = sem data de fim
  days: days.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});

/// areas vazio ou em falta = acede a tudo
const roleSchema = z.object({ role: z.enum(['USER', 'ADMIN']), areas: z.array(z.enum(ADMIN_AREAS)).max(20).nullable().optional() });

const promoCreateSchema = z.object({
  /// Vazio = gera um código (CONTALEX-XXXX-XXXX)
  code: z.string().trim().min(4).max(32).nullable().optional(),
  plan: z.string().trim().min(1).max(30),
  /// Quantos dias de plano dá (vazio = para sempre)
  durationDays: days.nullable().optional(),
  /// Quantas pessoas o podem usar (vazio = sem limite)
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  /// Até quando pode ser usado (vazio = sempre)
  expiresAt: isoDate.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  blockedAreas: z.array(z.string().max(30)).max(40).nullable().optional(),
  blockedFeatures: z.array(z.string().max(40)).max(40).nullable().optional(),
});

const promoUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  durationDays: days.nullable().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  blockedAreas: z.array(z.string().max(30)).max(40).nullable().optional(),
  blockedFeatures: z.array(z.string().max(40)).max(40).nullable().optional(),
});

const int = (value?: string) => (value ? Number(value) || undefined : undefined);

/// Rotas da administração (só administradores — ver ADMIN_EMAILS no .env).
/// Quem as usa é a área /admin do site (projeto contalex-web).
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly promo: PromoService,
    private readonly institutions: InstitutionsService,
    private readonly feedback: FeedbackService,
    private readonly creditsService: CreditsService,
  ) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.admin.overview(user.userId);
  }

  /// Receita por mês (só pagamentos reais). ?months=12&sandbox=true
  @Get('revenue')
  revenue(@CurrentUser() user: AuthUser, @Query('months') months?: string, @Query('sandbox') sandbox?: string) {
    return this.admin.revenue(user.userId, int(months) ?? 12, sandbox === 'true');
  }

  @Get('payments')
  payments(@Query('limit') limit?: string, @Query('sandbox') sandbox?: string) {
    return this.admin.payments(int(limit) ?? 50, sandbox === 'true');
  }

  /// ?kind=paid|trial|promo|grant|test|free (free = todos os que não pagaram)
  @Get('subscribers')
  subscribers(@Query() query: Record<string, string | undefined>) {
    return this.admin.subscribers({ ...query, limit: int(query.limit), offset: int(query.offset) });
  }

  /// ?q=&country=PT&language=pt&plan=FREE|PREMIUM|PREMIUM_PLUS&signup=google|password&platform=android|ios|web&from=&to=&active=7d|30d
  @Get('users')
  users(@Query() query: Record<string, string | undefined>) {
    return this.admin.users({ ...query, limit: int(query.limit), offset: int(query.offset) });
  }

  /// De onde vêm as pessoas (por país, registo e campanha).
  @Get('countries')
  countries() {
    return this.admin.countries();
  }

  /// Atribuir um plano sem pagamento (a ti próprio ou a outra pessoa).
  @Post('users/:id/grant')
  @HttpCode(200)
  grant(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(grantSchema)) dto: z.infer<typeof grantSchema>) {
    return this.admin.grant(user.userId, id, dto);
  }

  /// Tirar o plano não pago (oferta/código). O que foi pago na loja não muda.
  @Delete('users/:id/grant')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.revoke(id);
  }

  @Patch('users/:id/role')
  role(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(roleSchema)) dto: z.infer<typeof roleSchema>) {
    return this.admin.setRole(user.userId, id, dto.role, dto.areas ?? []);
  }

  /// Apagar a conta de vez (por exemplo, contas criadas pelos robôs de teste da Google Play).
  @Throttle(THROTTLE.strict)
  @Delete('users/:id')
  removeUser(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteUser(user.userId, id);
  }

  @Get('promo-codes')
  promoCodes() {
    return this.promo.list();
  }

  @Post('promo-codes')
  createPromoCode(@CurrentUser() user: AuthUser, @Body(new ZodBody(promoCreateSchema)) dto: z.infer<typeof promoCreateSchema>) {
    return this.promo.create(user.userId, dto);
  }

  @Patch('promo-codes/:id')
  updatePromoCode(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(promoUpdateSchema)) dto: z.infer<typeof promoUpdateSchema>) {
    return this.promo.update(id, dto);
  }

  @Delete('promo-codes/:id')
  removePromoCode(@Param('id', ParseUUIDPipe) id: string) {
    return this.promo.remove(id);
  }

  @Get('promo-codes/:id/redemptions')
  redemptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.promo.redemptions(id);
  }

  @Get('ai')
  ai() {
    return this.admin.ai();
  }

  /// Juntar créditos de IA a alguém (oferta).
  @Post('users/:id/credits')
  @HttpCode(200)
  credits(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(z.object({ credits: z.number().int().min(1).max(100_000), note: z.string().trim().max(200).nullable().optional() }))) body: { credits: number; note?: string | null }) {
    return this.creditsService.add(id, body.credits, 'GRANT', { note: body.note ?? null });
  }

  // ---------------------------------------------------------------- Bancos de referência

  @Get('institutions')
  institutionsList() {
    return this.institutions.listAll();
  }

  @Post('institutions')
  institutionCreate(@Body(new ZodBody(institutionSchema)) dto: z.infer<typeof institutionSchema>) {
    return this.institutions.create(dto);
  }

  @Patch('institutions/:id')
  institutionUpdate(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(institutionSchema.partial())) dto: Partial<z.infer<typeof institutionSchema>>) {
    return this.institutions.update(id, dto);
  }

  /// Carregar o logótipo (multipart, campo "file", só imagens).
  @Throttle(THROTTLE.uploads)
  @Post('institutions/:id/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024 } }))
  institutionLogo(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: UploadedFileLike) {
    return this.institutions.uploadLogo(id, file);
  }

  @Delete('institutions/:id')
  institutionRemove(@Param('id', ParseUUIDPipe) id: string) {
    return this.institutions.remove(id);
  }

  // ---------------------------------------------------------------- Feedback

  /// ?status=NEW|SEEN|DONE|all&kind=SUGGESTION|PROBLEM|OTHER|all
  @Get('feedback')
  feedbackList(@Query('status') status?: string, @Query('kind') kind?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.feedback.list({ status, kind, limit: int(limit), offset: int(offset) });
  }

  @Patch('feedback/:id')
  feedbackUpdate(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(feedbackUpdateSchema)) dto: z.infer<typeof feedbackUpdateSchema>) {
    return this.feedback.update(id, dto);
  }
}
