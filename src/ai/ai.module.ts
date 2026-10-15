import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiBudgetService } from './ai-budget.service';
import { AnthropicClient } from './anthropic.client';
import { AnalyticsModule } from '../analytics/analytics.module';
import { PlansModule } from '../plans/plans.module';
import { SimulatorModule } from '../simulator/simulator.module';
import { InsightsModule } from '../insights/insights.module';

@Module({
  imports: [AnalyticsModule, PlansModule, SimulatorModule, InsightsModule],
  controllers: [AiController],
  providers: [AiService, AiBudgetService, AnthropicClient],
  exports: [AiBudgetService, AiService],
})
export class AiModule {}
