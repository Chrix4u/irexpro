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
import { TradingViewWebhookController } from './tradingview-webhook.controller';
import { TradingViewWebhookService } from './tradingview-webhook.service';
import { TradingViewWebhookGuard } from '../../common/guards/tradingview-webhook.guard';
import { StrategyModule } from '../strategy/strategy.module';
import { AuditModule } from '../audit/audit.module';
import { ExecutionModule } from '../execution/execution.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { RiskModule } from '../risk/risk.module';
import { BrokerModule } from '../broker/broker.module';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';
import { VpsForexSignalCollectorController } from './vps-forex-signal-collector.controller';
import { BrokerParityV7Service } from './broker-parity-v7.service';
import { V8DedicatedPaperReadinessService } from './v8-dedicated-paper-readiness.service';
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
    BrokerModule,
  ],
  controllers: [
    AiController,
    AiDecisionExplorerController,
    AiCopilotController,
    ExternalSignalPerformanceController,
    TradingViewWebhookController,
    VpsForexSignalCollectorController,
  ],
  providers: [
    AiService,
    AiSignalService,
    AiDecisionExplorerService,
    AiCopilotService,
    InternalApiKeyGuard,
    ExternalSignalApiKeyGuard,
    ExternalSignalPerformanceService,
    TradingViewWebhookService,
    TradingViewWebhookGuard,
    VpsForexSignalCollectorService,
    BrokerParityV7Service,
    V8DedicatedPaperReadinessService,
  ],
  exports: [AiService, AiSignalService],
})
export class AiModule {}
