import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LockableResource, LocksService } from './locks.service';

const LOCK_RESOURCE = 'lockableResource';

/// Recusa (PLAN_ITEM_LOCKED) qualquer rota com `:id` cujo item esteja fechado
/// por a pessoa já não ter o plano pago com que o criou — ver, mudar e tudo o
/// que está por baixo dele. Só apagar o próprio item continua a ser possível.
@Injectable()
export class LockGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly locks: LocksService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.getAllAndOverride<LockableResource | undefined>(LOCK_RESOURCE, [context.getHandler(), context.getClass()]);
    if (!resource) return true;
    const request = context.switchToHttp().getRequest();
    const params = (request.params ?? {}) as Record<string, string>;
    const userId = request.user?.userId as string | undefined;
    if (!params.id || !userId) return true;
    // DELETE /<coisa>/:id — os dados são da pessoa: pode sempre apagá-los.
    if (request.method === 'DELETE' && Object.keys(params).length === 1) return true;
    await this.locks.assertUnlocked(userId, resource, params.id);
    return true;
  }
}

/// Marca um controlador cujos itens (o `:id` das rotas) ficam fechados quando
/// passam do limite do plano atual.
export const LockableItems = (resource: LockableResource) => applyDecorators(SetMetadata(LOCK_RESOURCE, resource), UseGuards(LockGuard));
