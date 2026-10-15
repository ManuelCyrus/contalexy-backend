import { isValidUsername, usernameBase } from './auth.dto';

describe('usernameBase (username de partida para quem entra com o Google)', () => {
  it('sai do email, limpo', () => {
    expect(usernameBase('Ana.Costa@gmail.com')).toBe('ana.costa');
    expect(usernameBase('joao+trabalho@empresa.pt')).toBe('joao');
    expect(usernameBase('José_Ávila-99@mail.com')).toBe('jose_avila.99');
    expect(usernameBase('..a...b..@x.pt')).toBe('a.b');
  });

  it('corta para caberem uns algarismos no fim (máximo 24)', () => {
    const base = usernameBase('um.nome.mesmo.muito.comprido.demais@gmail.com');
    expect(base.length).toBeLessThanOrEqual(19);
    expect(isValidUsername(`${base}99999`)).toBe(true);
  });

  it('se o email não der, usa o nome; se nada der, "user"', () => {
    expect(usernameBase('ab@x.pt', 'Rui Silva')).toBe('rui.silva');
    expect(usernameBase('admin@x.pt', 'Maria')).toBe('maria');
    expect(usernameBase('ab@x.pt', null)).toBe('user');
    expect(usernameBase('ab@x.pt', '李')).toBe('user');
  });

  it('nunca devolve um username inválido', () => {
    for (const email of ['a@b.c', '___@x.pt', 'contalex@x.pt', 'x.y.z@x.pt', 'A_B@x.pt']) {
      expect(isValidUsername(usernameBase(email))).toBe(true);
    }
  });
});
