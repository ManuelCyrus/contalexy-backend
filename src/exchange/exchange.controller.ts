import { Controller, Get, Query } from '@nestjs/common';
import { ExchangeService } from './exchange.service';

@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  @Get('rates')
  rates(@Query('base') base?: string) {
    const code = (base ?? 'EUR').toUpperCase();
    return this.exchange.latest(/^[A-Z]{3}$/.test(code) ? code : 'EUR');
  }
}
