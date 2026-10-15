import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../common/decorators/public.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { forgotSchema, googleSchema, GoogleDto, loginSchema, LoginDto, refreshSchema, registerSchema, RegisterDto, resetSchema } from './auth.dto';

const strict = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(strict)
  @Post('register')
  register(@Body(new ZodBody(registerSchema)) dto: RegisterDto, @ClientIp() ip: string | null, @Headers('user-agent') userAgent?: string) {
    return this.auth.register(dto, { userAgent, ip });
  }

  @Public()
  @Throttle(strict)
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodBody(loginSchema)) dto: LoginDto, @ClientIp() ip: string | null, @Headers('user-agent') userAgent?: string) {
    return this.auth.login(dto, { userAgent, ip });
  }

  /// Entrar ou criar conta com o Google (a app manda o ID token).
  @Public()
  @Throttle(strict)
  @Post('google')
  @HttpCode(200)
  google(@Body(new ZodBody(googleSchema)) dto: GoogleDto, @ClientIp() ip: string | null, @Headers('user-agent') userAgent?: string) {
    return this.auth.google(dto, { userAgent, ip });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodBody(refreshSchema)) dto: z.infer<typeof refreshSchema>, @ClientIp() ip: string | null, @Headers('user-agent') userAgent?: string) {
    return this.auth.refresh(dto.refreshToken, { userAgent, ip });
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Body(new ZodBody(refreshSchema)) dto: z.infer<typeof refreshSchema>) {
    return this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  forgot(@Body(new ZodBody(forgotSchema)) dto: z.infer<typeof forgotSchema>) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle(strict)
  @Post('reset-password')
  @HttpCode(200)
  reset(@Body(new ZodBody(resetSchema)) dto: z.infer<typeof resetSchema>, @ClientIp() ip: string | null, @Headers('user-agent') userAgent?: string) {
    return this.auth.resetPassword(dto.email, dto.code, dto.newPassword, { userAgent, ip });
  }

  @Public()
  @Get('username-available')
  usernameAvailable(@Query('username') username = '') {
    return this.auth.usernameAvailable(username);
  }
}
