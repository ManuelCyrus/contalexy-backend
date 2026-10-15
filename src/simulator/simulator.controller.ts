import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { savingsSimSchema, SavingsSimDto, simulateSavings } from './savings';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { SimulatorService } from './simulator.service';
import { forecastSimSchema, ForecastSimDto, goalSimSchema, GoalSimDto, purchaseSimSchema, PurchaseSimDto } from './simulator.dto';

/// Simulador "E se eu fizer isto?" e previsão do mês — contas do servidor,
/// sem IA e sem limite de utilizações.
@Controller('simulator')
export class SimulatorController {
  constructor(private readonly simulator: SimulatorService) {}

  /// Como acaba este mês e os próximos, objetivos e riscos.
  @Get('outlook')
  outlook(@CurrentUser() user: AuthUser) {
    return this.simulator.outlook(user.userId);
  }

  /// "E se eu comprar isto agora / daqui a X meses / a guardar Y por mês?"
  @Post('purchase')
  @HttpCode(200)
  purchase(@CurrentUser() user: AuthUser, @Body(new ZodBody(purchaseSimSchema)) dto: PurchaseSimDto) {
    return this.simulator.purchase(user.userId, dto);
  }

  /// "Quanto tempo demoro a juntar X a guardar Y por mês?"
  @Post('goal')
  @HttpCode(200)
  goal(@CurrentUser() user: AuthUser, @Body(new ZodBody(goalSimSchema)) dto: GoalSimDto) {
    return this.simulator.goal(user.userId, dto);
  }

  /// Vários meses à frente com alterações ("e se eu ganhar/gastar/poupar mais?").
  @Post('forecast')
  @HttpCode(200)
  forecast(@CurrentUser() user: AuthUser, @Body(new ZodBody(forecastSimSchema)) dto: ForecastSimDto) {
    return this.simulator.forecast(user.userId, dto);
  }

  /// Calculadora de poupança: saldo futuro, juros, imposto e quando se chega
  /// à meta. Contas determinísticas (sem IA).
  @Post('savings')
  @HttpCode(200)
  savings(@Body(new ZodBody(savingsSimSchema)) dto: SavingsSimDto) {
    return simulateSavings(dto);
  }
}
