import { Logger } from '@nestjs/common';
import { createSign, generateKeyPairSync, KeyObject } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { resetEnvCache } from '../config/env';
import { GoogleVerifier, googleClientIds } from './google.verifier';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/// Um "ID token" como os da Google (JWT RS256), assinado com a chave dada.
function signToken(key: KeyObject, payload: Record<string, unknown>, kid = 'chave-1') {
  const head = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
}

describe('GoogleVerifier', () => {
  beforeEach(() => {
    Object.assign(process.env, { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) });
  });

  it('lê os IDs de cliente separados por vírgulas', () => {
    expect(googleClientIds(' a.apps.googleusercontent.com , ,b.apps.googleusercontent.com ')).toEqual(['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com']);
    expect(googleClientIds('')).toEqual([]);
  });

  it('sem GOOGLE_CLIENT_IDS responde "indisponível" (não tenta confirmar nada)', async () => {
    process.env.GOOGLE_CLIENT_IDS = '';
    resetEnvCache();
    const verifier = new GoogleVerifier();
    expect(verifier.enabled).toBe(false);
    await expect(verifier.verify('x'.repeat(40))).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONFIGURED' });
  });

  // Aqui corre a verificação a sério da biblioteca da Google (assinatura, emissor,
  // destinatário, validade). Só as chaves públicas, que o servidor iria buscar à
  // Google, são trocadas por uma chave criada no teste.
  describe('com tokens assinados', () => {
    const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const intruder = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const APP = '1234-app.apps.googleusercontent.com';
    const WEB = '9999-web.apps.googleusercontent.com';
    const now = () => Math.floor(Date.now() / 1000);
    const claims = (over: Record<string, unknown> = {}) => ({
      iss: 'https://accounts.google.com',
      azp: '1234-android.apps.googleusercontent.com',
      aud: APP,
      sub: '108000000000000000001',
      email: 'Maria.Silva@Gmail.com',
      email_verified: true,
      name: ' Maria Silva ',
      picture: 'https://lh3.googleusercontent.com/a/foto',
      iat: now() - 10,
      exp: now() + 3600,
      ...over,
    });
    let warn: jest.SpyInstance;

    beforeEach(() => {
      process.env.GOOGLE_CLIENT_IDS = `${APP}, ${WEB}`;
      resetEnvCache();
      const certs = { 'chave-1': google.publicKey.export({ type: 'spki', format: 'pem' }) as string };
      jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs, format: 'PEM' } as never);
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
      process.env.GOOGLE_CLIENT_IDS = '';
      resetEnvCache();
    });

    it('aceita um token verdadeiro e devolve a identidade (email em minúsculas)', async () => {
      const verifier = new GoogleVerifier();
      expect(verifier.enabled).toBe(true);
      await expect(verifier.verify(signToken(google.privateKey, claims()))).resolves.toEqual({
        sub: '108000000000000000001',
        email: 'maria.silva@gmail.com',
        emailVerified: true,
        name: 'Maria Silva',
        picture: 'https://lh3.googleusercontent.com/a/foto',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('aceita qualquer um dos IDs de cliente configurados e o emissor sem "https://"', async () => {
      const token = signToken(google.privateKey, claims({ aud: WEB, iss: 'accounts.google.com' }));
      await expect(new GoogleVerifier().verify(token)).resolves.toMatchObject({ sub: '108000000000000000001' });
    });

    it('diz quando a Google não confirmou o email (quem decide é o serviço de contas)', async () => {
      const token = signToken(google.privateKey, claims({ email_verified: false, name: undefined, picture: undefined }));
      await expect(new GoogleVerifier().verify(token)).resolves.toEqual({
        sub: '108000000000000000001',
        email: 'maria.silva@gmail.com',
        emailVerified: false,
        name: null,
        picture: null,
      });
    });

    it.each([
      ['emitido para outra app', () => signToken(google.privateKey, claims({ aud: 'outra-app.apps.googleusercontent.com' })), 'Wrong recipient'],
      ['fora de prazo', () => signToken(google.privateKey, claims({ iat: now() - 7200, exp: now() - 3600 })), 'Token used too late'],
      ['de outro emissor', () => signToken(google.privateKey, claims({ iss: 'https://accounts.exemplo.com' })), 'Invalid issuer'],
      ['assinado com outra chave', () => signToken(intruder.privateKey, claims()), 'Invalid token signature'],
      ['com uma chave que a Google não tem', () => signToken(google.privateKey, claims(), 'chave-desconhecida'), 'No pem found'],
      ['sem email', () => signToken(google.privateKey, claims({ email: undefined })), 'sem email'],
      ['que não é um token', () => 'isto-nao-e-um-token', ''],
    ])('recusa um token %s', async (_what, make, reason) => {
      const token = make();
      await expect(new GoogleVerifier().verify(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
      // O motivo fica no log do servidor — sem o token lá dentro.
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(logged).toContain(reason);
      expect(logged).not.toContain(token);
    });
  });
});
