import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { SUPPORTED_LANGUAGES } from '../common/i18n/messages';
import { HELP_KEY, HELP_PHRASES, HELP_SECTIONS, HelpGuard, helpActionOf, helpLabelOf, helpPhrase, helpSections } from './help';

describe('ajudar a gerir', () => {
  it('só nas áreas escolhidas, à vista, sem categorias reservadas e com o que entra no plano e nas despesas fixas', () => {
    const base = { sections: ['goals', 'budgets', 'plan', 'recurring', 'transactions'], hiddenCategoryIds: [] as string[] };
    expect(helpSections({ ...base, manageSections: ['goals', 'transactions', 'plans'] })).toEqual(['goals', 'transactions']);
    // Plano do mês e despesas fixas pedem o que entra à vista.
    expect(helpSections({ ...base, manageSections: ['plan', 'recurring'] })).toEqual([]);
    expect(helpSections({ ...base, sections: [...base.sections, 'income'], manageSections: ['plan', 'recurring'] })).toEqual(['plan', 'recurring']);
    // Com categorias reservadas, nada.
    expect(helpSections({ ...base, hiddenCategoryIds: ['c1'], manageSections: ['goals'] })).toEqual([]);
    // Nomes que não existem não contam.
    expect(helpSections({ ...base, manageSections: ['tudo', 'goals'] })).toEqual(['goals']);
  });

  it('o que conta como criar, alterar e apagar', () => {
    expect(helpActionOf('create')).toBe('create');
    expect(helpActionOf('remove')).toBe('delete');
    expect(helpActionOf('addStep')).toBe('update');
    expect(helpActionOf('removeItem')).toBe('update');
    expect(helpActionOf('save')).toBe('update');
  });

  it('o nome do que mudou vem da resposta (embrulhada ou não)', () => {
    expect(helpLabelOf({ name: 'Férias' })).toBe('Férias');
    expect(helpLabelOf({ success: true, data: { description: '  Pão  ' } })).toBe('Pão');
    expect(helpLabelOf({ deleted: true })).toBeNull();
    expect(helpLabelOf(null)).toBeNull();
  });

  it('as frases dos avisos existem em todas as línguas, sem travessões', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const section of HELP_SECTIONS) {
        for (const action of ['create', 'update', 'delete'] as const) {
          const text = HELP_PHRASES[lang][section][action];
          expect(text).toBeTruthy();
          expect(text).not.toMatch(/[–—]/);
        }
      }
    }
    expect(helpPhrase('pt', 'goals', 'create', 'Carta')).toBe('Criou um objetivo: Carta.');
    expect(helpPhrase('de', 'budgets', 'delete', null)).toBe('Hat ein Limit gelöscht.');
  });

  describe('HelpGuard', () => {
    const access = {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: 'dona',
      viewerId: 'mae',
      status: 'ACTIVE',
      sections: ['goals', 'budgets'],
      manageSections: ['goals'],
      hiddenCategoryIds: [] as string[],
      owner: { email: 'dona@ex.pt', deletionRequestedAt: null },
      viewer: { name: 'Mãe' },
    };
    const setup = (rule: unknown, headers: Record<string, string>, row: unknown = access) => {
      const request: Record<string, unknown> = { headers, user: { userId: 'mae', email: 'mae@ex.pt', sessionId: 's1' } };
      const context = {
        getType: () => 'http',
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      const reflector = { getAllAndOverride: (key: string) => (key === HELP_KEY ? rule : undefined) } as unknown as Reflector;
      const prisma = { sharedAccess: { findUnique: jest.fn().mockResolvedValue(row) } };
      return { request, context, guard: new HelpGuard(reflector, prisma as never) };
    };
    const header = { 'x-contalex-help': access.id };

    it('sem o cabeçalho, nada muda', async () => {
      const { guard, context, request } = setup(undefined, {});
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect((request.user as { userId: string }).userId).toBe('mae');
    });

    it('passa a agir como quem partilha, guardando quem ajuda', async () => {
      const { guard, context, request } = setup({ sections: ['goals'], write: true }, header);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toMatchObject({ userId: 'dona', sessionId: null, help: { actorId: 'mae', actorName: 'Mãe', section: 'goals', write: true, income: false, manage: ['goals'] } });
    });

    it('recusa rotas sem @Help, áreas sem permissão, acessos alheios e por aceitar', async () => {
      await expect(setup(undefined, header).guard.canActivate(setup(undefined, header).context)).rejects.toMatchObject({ code: 'SHARE_HELP_NOT_ALLOWED' });
      const budgets = setup({ sections: ['budgets'], write: true }, header);
      await expect(budgets.guard.canActivate(budgets.context)).rejects.toMatchObject({ code: 'SHARE_HELP_SECTION' });
      const stranger = setup({ sections: ['goals'], write: false }, header, { ...access, viewerId: 'outro' });
      await expect(stranger.guard.canActivate(stranger.context)).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
      const pending = setup({ sections: ['goals'], write: false }, header, { ...access, status: 'PENDING' });
      await expect(pending.guard.canActivate(pending.context)).rejects.toMatchObject({ code: 'SHARE_NOT_ACTIVE' });
      const hidden = setup({ sections: ['goals'], write: false }, header, { ...access, hiddenCategoryIds: ['c1'] });
      await expect(hidden.guard.canActivate(hidden.context)).rejects.toMatchObject({ code: 'SHARE_HELP_OFF' });
      const bad = setup({ sections: 'any', write: false }, { 'x-contalex-help': 'nada' });
      await expect(bad.guard.canActivate(bad.context)).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
    });
  });
});
