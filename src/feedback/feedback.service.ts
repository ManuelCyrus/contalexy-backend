import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { MailService } from '../mail/mail.service';
import { env } from '../config/env';

export const FEEDBACK_KINDS = ['SUGGESTION', 'PROBLEM', 'OTHER'] as const;
export const feedbackSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS).default('OTHER'),
  message: z.string().trim().min(5).max(2000),
  appVersion: z.string().trim().max(40).optional(),
  platform: z.string().trim().max(16).optional(),
});
export const feedbackUpdateSchema = z.object({
  status: z.enum(['NEW', 'SEEN', 'DONE']).optional(),
  adminNote: z.string().trim().max(500).nullable().optional(),
});

/// Sugestões e problemas enviados pela app; a administração vê, marca e anota.
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async create(userId: string, dto: z.infer<typeof feedbackSchema>) {
    // No máximo 10 por dia por pessoa.
    const recent = await this.prisma.feedback.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (recent >= 10) throw ApiException.tooManyRequests('FEEDBACK_LIMIT');
    const row = await this.prisma.feedback.create({ data: { userId, kind: dto.kind, message: dto.message, appVersion: dto.appVersion ?? null, platform: dto.platform ?? null } });
    const to = env().SUPPORT_EMAIL;
    if (to) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, country: true } });
      this.mail.send(to, `[Contalexy] ${dto.kind}: ${dto.message.slice(0, 60)}`, `${user?.name} <${user?.email}> (${user?.country}), ${dto.platform ?? ''} ${dto.appVersion ?? ''}\n\n${dto.message}`).catch(() => undefined);
    }
    return { id: row.id, createdAt: row.createdAt };
  }

  async mine(userId: string) {
    const rows = await this.prisma.feedback.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, kind: r.kind, message: r.message, status: r.status, createdAt: r.createdAt }));
  }

  async list(query: { status?: string; kind?: string; limit?: number; offset?: number }) {
    const where = { ...(query.status && query.status !== 'all' ? { status: query.status.toUpperCase() } : {}), ...(query.kind && query.kind !== 'all' ? { kind: query.kind.toUpperCase() } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' }, skip: Math.max(query.offset ?? 0, 0), take: Math.min(Math.max(query.limit ?? 50, 1), 200), include: { user: { select: { id: true, name: true, email: true, country: true } } } }),
    ]);
    return { total, items: rows };
  }

  async update(id: string, dto: z.infer<typeof feedbackUpdateSchema>) {
    const existing = await this.prisma.feedback.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('NOT_FOUND');
    return this.prisma.feedback.update({ where: { id }, data: { ...(dto.status ? { status: dto.status } : {}), ...(dto.adminNote !== undefined ? { adminNote: dto.adminNote } : {}) } });
  }
}
