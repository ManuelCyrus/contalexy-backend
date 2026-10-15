import { z } from 'zod';

/// Uma mensagem curta, como um SMS (até 1000 caracteres).
export const messageSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});
export type MessageDto = z.infer<typeof messageSchema>;

const moment = z.string().datetime({ offset: true }).optional();

/// `after` = só as novas desde essa mensagem (para ir atualizando a conversa);
/// `before` = as mais antigas (ao subir na conversa).
export const messagesQuerySchema = z.object({
  before: moment,
  after: moment,
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
