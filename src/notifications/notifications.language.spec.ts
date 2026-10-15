import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AuthService } from '../auth/auth.service';
import { mailText, NOTIFICATIONS, notificationText, SUPPORTED_LANGUAGES } from '../common/i18n/messages';
import { formatMoney } from '../common/utils/money';
import { NotificationsService } from './notifications.service';

/// Quem recebe é que decide a língua: a guardada na conta dele
/// (a app mantém-na igual à que a pessoa usa no telemóvel).
function setup(language: string, country = 'PT') {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ language, country, currency: 'EUR', notificationPrefs: {} }) },
    notification: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
  const push = { enabled: true, sendToUser: jest.fn().mockResolvedValue(undefined) };
  return { push, service: new NotificationsService(prisma as never, push as never) };
}

type Sent = { title: string; body: string };

describe('avisos e emails na língua de quem os recebe', () => {
  it('o push sai na língua da conta de quem o recebe', async () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const { push, service } = setup(lang);
      await service.notify('u1', 'item_offer', { offerId: 'o1', from: 'Ana', title: 'Arroz' });
      const sent = push.sendToUser.mock.calls[0][1] as Sent;
      expect(sent.title).toBe(notificationText('item_offer', 'title', lang, { from: 'Ana' }));
      expect(sent.body).toBe(notificationText('item_offer', 'body', lang, { title: 'Arroz' }));
    }
    const titles = new Set(SUPPORTED_LANGUAGES.map((lang) => notificationText('item_offer', 'title', lang, { from: 'Ana' })));
    expect(titles.size).toBe(SUPPORTED_LANGUAGES.length);
  });

  it('uma língua que a app não tem vai em inglês', async () => {
    const { push, service } = setup('es', 'ES');
    await service.notify('u1', 'item_offer', { offerId: 'o1', from: 'Ana', title: 'Arroz' });
    expect((push.sendToUser.mock.calls[0][1] as Sent).title).toBe(notificationText('item_offer', 'title', 'en', { from: 'Ana' }));
  });

  it('os valores vão escritos à maneira de quem recebe', async () => {
    const { push, service } = setup('de', 'DE');
    const money = (lang: string, country: string, v: number) => formatMoney(v, 'EUR', lang, country);
    await service.notify('u1', 'daily_limit_warning', { spent: 18, limit: 20, left: 2 }, (ctx) => ({
      spent: money(ctx.lang, ctx.country, 18),
      limit: money(ctx.lang, ctx.country, 20),
      left: money(ctx.lang, ctx.country, 2),
    }));
    const expected = notificationText('daily_limit_warning', 'body', 'de', { spent: money('de', 'DE', 18), limit: money('de', 'DE', 20), left: money('de', 'DE', 2) });
    expect((push.sendToUser.mock.calls[0][1] as Sent).body).toBe(expected);
    expect(expected).toContain('18,00');
  });

  it('o email de recuperação vai na língua da conta', async () => {
    const mail = { send: jest.fn().mockResolvedValue(true) };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', name: 'Marie Curie', email: 'marie@example.com', language: 'fr' }) },
      passwordReset: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
    };
    const auth = new AuthService(prisma as never, {} as never, {} as never, mail as never, {} as never);
    await auth.forgotPassword('marie@example.com');
    const [to, subject, text] = mail.send.mock.calls[0] as [string, string, string];
    expect(to).toBe('marie@example.com');
    expect(subject).toBe(mailText('reset.subject', 'fr'));
    expect(subject).not.toBe(mailText('reset.subject', 'en'));
    expect(text).toContain('Marie');
  });

  it('cada aviso que o servidor manda tem texto em todas as línguas', () => {
    // Sem texto, o push não sai (e ninguém dava por isso).
    const sent = new Set<string>();
    const scan = (source: string) => {
      for (const line of source.split('\n')) {
        if (!/\.(notify|tell|tellOthers)\(|\btype = /.test(line)) continue;
        for (const m of line.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) sent.add(m[1]);
      }
      // Chamadas partidas em várias linhas: notify(\n  quem,\n  'tipo', …
      for (const m of source.matchAll(/\.notify\(\s*[^,()]+(?:\([^()]*\))?,\s*'([a-z]+(?:_[a-z]+)+)'/g)) sent.add(m[1]);
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'generated') walk(path);
        } else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
          scan(readFileSync(path, 'utf8'));
        }
      }
    };
    walk(join(__dirname, '..'));
    // Lembretes de empréstimos: o tipo é montado (loan_<lado>_<momento>).
    for (const side of ['lent', 'borrowed']) for (const when of ['due_soon', 'due_today', 'overdue']) sent.add(`loan_${side}_${when}`);

    const missing: string[] = [];
    for (const type of sent) {
      for (const part of ['title', 'body']) {
        const texts = NOTIFICATIONS[`${type}.${part}`] as Record<string, string> | undefined;
        for (const lang of SUPPORTED_LANGUAGES) if (!texts?.[lang]) missing.push(`${type}.${part}.${lang}`);
      }
    }
    expect(sent.size).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });
});
