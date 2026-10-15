import { categoryName, ERRORS, errorMessage, MAIL, NOTIFICATIONS, notificationText, resolveLanguage, SUPPORTED_LANGUAGES } from './messages';

describe('idiomas', () => {
  it('escolhe o idioma pelo Accept-Language (desconhecido → inglês)', () => {
    expect(resolveLanguage('pt-PT,pt;q=0.9')).toBe('pt');
    expect(resolveLanguage('es-ES,es;q=0.9,fr;q=0.5')).toBe('fr');
    expect(resolveLanguage('es-ES')).toBe('en');
    expect(resolveLanguage(undefined)).toBe('en');
  });

  it('mensagens traduzidas com parâmetros', () => {
    expect(errorMessage('PLAN_LIMIT_REACHED', 'pt', { max: 3 })).toContain('(3)');
    expect(errorMessage('NAO_EXISTE', 'pt')).toBeNull();
    expect(categoryName('food', 'de')).toBe('Essen');
    expect(notificationText('budget_alert', 'title', 'fr', { name: 'Courses' })).toBe('Budget Courses');
    expect(notificationText('daily_limit_warning', 'body', 'pt', { spent: '18,00 €', limit: '20,00 €', left: '2,00 €' })).toBe('Já gastaste 18,00 € de 20,00 €. Faltam 2,00 €.');
    expect(notificationText('item_offer', 'title', 'en', { from: 'Ana' })).toBe('Ana sent you something');
  });

  it('todos os textos existem nos idiomas todos', () => {
    const tables: Array<[string, Record<string, Record<string, unknown>>]> = [['erros', ERRORS], ['avisos', NOTIFICATIONS], ['emails', MAIL as unknown as Record<string, Record<string, unknown>>]];
    const missing: string[] = [];
    for (const [table, entries] of tables) {
      for (const [key, texts] of Object.entries(entries)) {
        for (const lang of SUPPORTED_LANGUAGES) if (texts[lang] === undefined || texts[lang] === '') missing.push(`${table}.${key}.${lang}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('textos escritos como uma pessoa escreve: sem travessões nem emojis', () => {
    const marks = /[\u2013\u2014\u2600-\u27BF\u2B50\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF]/;
    const bad: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (marks.test(value)) bad.push(path);
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(ERRORS, 'erros');
    walk(NOTIFICATIONS, 'avisos');
    walk(MAIL, 'emails');
    expect(bad).toEqual([]);
  });
});
