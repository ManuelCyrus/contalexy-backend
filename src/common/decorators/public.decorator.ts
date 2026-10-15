import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/// Rota sem sessão (registo, login, webhooks…).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
