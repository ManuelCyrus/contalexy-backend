import { Global, Module } from '@nestjs/common';
import { GoogleVerifier } from './google.verifier';

/// Confirmação de contas Google (entrar com o Google, confirmar ações).
@Global()
@Module({
  providers: [GoogleVerifier],
  exports: [GoogleVerifier],
})
export class GoogleModule {}
