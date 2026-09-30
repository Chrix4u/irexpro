import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AiSignalService } from './ai-signal.service';
import { AiDecisionExplorerService } from './ai-decision-explorer.service';
import { AiCopilotService } from './ai-copilot.service';
import { AiController } from './ai.controller';
import { AiDecisionExplorerController } from './ai-decision-explorer.controller';
import { AiCopilotController } from './ai-copilot.controller';
import { ExternalSignalPerformanceController } from './external-signal-performance.controller';
import { ExternalSignalPerformanceService } from './external-signal-performance.service';
import { StrategyModule } from '../strategy/strategy.module';
import { AuditModule } from '../audit/audit.module';
import { ExecutionModule } from '../execution/execution.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { RiskModule } from '../risk/risk.module';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { ExternalSignalApiKeyGuard } from '../../common/guards/external-signal-api-key.guard';

/**
 * AiModule — AI Signal Engine intake, routing, and browser-safe intelligence.
 *
 * Mutation pipeline:
 *   AiSignalService → StrategyOrchestratorService → RiskService → ExecutionService
 *   (never: AiSignalService or Copilot → ExecutionService/Broker directly)
 *
 * Decision Explorer and Contextual Copilot are read-only. The Copilot composes
 * exported Market Intelligence, Risk Intelligence, persisted decision evidence,
 * and deterministic Strategy Lab research without exposing hidden model reasoning
 * or creating a second execution/risk authority.
 */
@Module({
  imports: [
    ConfigModule,
    StrategyModule,
    AuditModule,
    ExecutionModule,
    MarketDataModule,
    RiskModule,
  ],
  controllers: [
    AiController,
    AiDecisionExplorerController,
    AiCopilotController,
    ExternalSignalPerformanceController,
  ],
  providers: [
    AiService,
    AiSignalService,
    AiDecisionExplorerService,
    AiCopilotService,
    InternalApiKeyGuard,
    ExternalSignalApiKeyGuard,
    ExternalSignalPerformanceService,
  ],
  exports: [AiService, AiSignalService],
})
export class AiModule {}
