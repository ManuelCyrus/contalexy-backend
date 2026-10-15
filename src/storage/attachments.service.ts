import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StorageService, UploadedFileLike } from './storage.service';
import { ApiException } from '../common/errors/api.exception';
import { AttachmentKind } from '../generated/prisma/client';

export interface AttachmentDto {
  id: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  url: string;
  createdAt: Date;
}

export const toAttachmentDto = (a: { id: string; kind: AttachmentKind; mimeType: string; size: number; createdAt: Date }): AttachmentDto => ({
  id: a.id,
  kind: a.kind,
  mimeType: a.mimeType,
  size: a.size,
  url: `/v1/files/${a.id}`,
  createdAt: a.createdAt,
});

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async upload(userId: string, file: UploadedFileLike | undefined, kind: AttachmentKind, link: { transactionId?: string; spaceExpenseId?: string } = {}) {
    const saved = await this.storage.save(file as UploadedFileLike, `attachments/${kind.toLowerCase()}`);
    const attachment = await this.prisma.attachment.create({
      data: { userId, kind, storageKey: saved.key, mimeType: saved.mimeType, size: saved.size, ...link },
    });
    return toAttachmentDto(attachment);
  }

  /// Quem pode ver: o dono; e, num Space, quem é membro desse Space.
  async findReadable(userId: string, id: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
      include: { spaceExpense: { select: { spaceId: true } } },
    });
    if (!attachment) throw ApiException.notFound('FILE_NOT_FOUND');
    if (attachment.userId === userId) return attachment;
    if (attachment.spaceExpense) {
      const member = await this.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: attachment.spaceExpense.spaceId, userId } },
        select: { id: true },
      });
      if (member) return attachment;
    }
    throw ApiException.notFound('FILE_NOT_FOUND');
  }

  /// Anexos ainda soltos (carregados antes de gravar o movimento) passam
  /// a pertencer ao movimento. Só os da própria pessoa.
  async linkToTransaction(userId: string, transactionId: string, attachmentIds: string[]) {
    if (!attachmentIds.length) return;
    await this.prisma.attachment.updateMany({
      where: { id: { in: attachmentIds }, userId, transactionId: null, spaceExpenseId: null },
      data: { transactionId },
    });
  }

  async linkToSpaceExpense(userId: string, spaceExpenseId: string, attachmentIds: string[]) {
    if (!attachmentIds.length) return;
    await this.prisma.attachment.updateMany({
      where: { id: { in: attachmentIds }, userId, transactionId: null, spaceExpenseId: null },
      data: { spaceExpenseId, kind: 'SPACE_RECEIPT' },
    });
  }

  async remove(userId: string, id: string) {
    const attachment = await this.prisma.attachment.findFirst({ where: { id, userId } });
    if (!attachment) throw ApiException.notFound('FILE_NOT_FOUND');
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(attachment.storageKey);
    return { deleted: true };
  }

  /// Apaga do disco os ficheiros de uma lista de anexos (ex.: ao apagar a conta).
  async removeFiles(keys: string[]) {
    for (const key of keys) await this.storage.remove(key);
  }
}
