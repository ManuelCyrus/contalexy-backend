import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { InsightsService } from './insights.service';

@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /// Análise de desperdícios (contas do servidor, sem IA).
  @Get('waste')
  waste(@CurrentUser() user: AuthUser) {
    return this.insights.waste(user.userId);
  }
}
