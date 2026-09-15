import { Body, Controller, ForbiddenException, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import {
  InternalApiKeyGuard,
  INTERNAL_API_KEY_HEADER,
} from '../../common/guards/internal-api-key.guard';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { AiSignalService } from './ai-signal.service';
import { SimulateSignalDto } from './dto/simulate-signal.dto';
import { InternalSignalDto } from './dto/internal-signal.dto';
// Round 6 live-execution completion (§10): the internal exit-signal intake.
import { InternalExitSignalDto } from './dto/internal-exit-signal.dto';
import { StrategyResult } from '../strategy/interfaces/strategy.interface';
import { AiExitResult } from '../strategy/interfaces/ai-exit-signal.interface';
import { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';
import { v4 as uuidv4 } from 'uuid';

/**
 * AiController
 *
 * Provides two categories of endpoints:
 *
 * 1. DEV/TEST — POST /ai/dev/simulate-signal
 *    - Disabled in production
 *    - Requires JWT authentication
 *    - Simulates signals for pipeline testing
 *
 * 2. INTERNAL — POST /ai/internal/signals (entries)
 *              POST /ai/internal/exit-signals (§10 exits)
 *    - For Python AI Engine → NestJS integration
 *    - Protected by x-irexpro-internal-api-key header (InternalApiKeyGuard)
 *    - Not accessible with user JWT alone
 *    - All signals go through the FULL pipeline
 *
 * ═══════════════════════════════════════════════════════════════════════
 * There is NO direct AI → Broker shortcut. Every signal path goes through:
 *   AiSignalService → StrategyOrchestrator → RiskEngine → ExecutionEngine → Broker
 * ═══════════════════════════════════════════════════════════════════════
 */
@ApiTags('AI')
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiSignalService: AiSignalService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * DEV/TEST ONLY: Simulate an AI signal for pipeline testing.
   *
   * Disabled in production (NODE_ENV=production).
   * Requires JWT authentication.
   * Routes signal through full pipeline — does NOT bypass Risk Engine.
   *
   * POST /api/v1/ai/dev/simulate-signal
   */
  @Post('dev/simulate-signal')
  @ApiOperation({
    summary: '[DEV ONLY] Simulate an AI signal for pipeline testing',
    description:
      'DISABLED IN PRODUCTION. Submits a simulated signal through the full ' +
      'Strategy Orchestrator → Risk Engine → Execution Engine pipeline. ' +
      'Does not bypass any safety gates.',
  })
  async simulateSignal(
    @CurrentUserId() userId: string,
    @Body() dto: SimulateSignalDto,
  ): Promise<StrategyResult> {
    const env = this.configService.get<string>('app.env', 'development');
    if (env === 'production') {
      this.logger.warn(
        `DEV simulate-signal endpoint was called in PRODUCTION by user=${userId} — BLOCKED`,
      );
      throw new ForbiddenException('This endpoint is disabled in production');
    }

    this.logger.log(
      `[DEV] Simulated signal from user=${userId} ` +
        `instrument=${dto.instrument} direction=${dto.direction} ` +
        `session=${dto.tradingSessionId}`,
    );

    const candidate = this.aiSignalService.buildSimulatedCandidate(userId, {
      tradingSessionId: dto.tradingSessionId,
      brokerConnectionId: dto.brokerConnectionId,
      instrument: dto.instrument,
      direction: dto.direction,
      confidenceScore: dto.confidenceScore,
      suggestedEntryPrice: dto.suggestedEntryPrice,
      suggestedStopLoss: dto.suggestedStopLoss,
      suggestedTakeProfit: dto.suggestedTakeProfit,
      suggestedVolume: dto.suggestedVolume,
      timeframe: dto.timeframe,
      strategyCode: dto.strategyCode,
      marketRegime: dto.marketRegime,
      volatilityScore: dto.volatilityScore,
      modelVersion: dto.modelVersion,
      metadata: { source: 'dev-simulate', env },
    });

    return this.aiSignalService.receiveSignal(candidate);
  }

  /**
   * INTERNAL: Receive a signal candidate from the Python AI Engine.
   *
   * Protected by InternalApiKeyGuard — requires x-irexpro-internal-api-key header.
   * Not accessible via user JWT alone.
   * Routes through the FULL pipeline — does NOT bypass Risk Engine or subscriptions.
   *
   * POST /api/v1/ai/internal/signals
   */
  @Post('internal/signals')
  @Public()
  @UseGuards(InternalApiKeyGuard)
  @ApiOperation({
    summary: '[INTERNAL] Receive signal from Python AI Engine',
    description:
      'Service-to-service endpoint for the Python AI Engine. ' +
      'Protected by internal API key (x-irexpro-internal-api-key). ' +
      'All signals route through the full Strategy Orchestrator → Risk Engine → Execution pipeline. ' +
      'Does not bypass any safety gates.',
  })
  @ApiHeader({
    name: INTERNAL_API_KEY_HEADER,
    description: 'Internal service API key',
    required: true,
  })
  async receiveInternalSignal(@Body() dto: InternalSignalDto): Promise<StrategyResult> {
    this.logger.log(
      `[INTERNAL] Signal received from AI engine: ` +
        `instrument=${dto.instrument} direction=${dto.direction} ` +
        `user=${dto.userId} model=${dto.modelVersion}`,
    );

    const candidate: AiSignalCandidate = {
      signalId: dto.signalId ?? uuidv4(),
      userId: dto.userId,
      tradingSessionId: dto.tradingSessionId,
      brokerConnectionId: dto.brokerConnectionId,
      instrument: dto.instrument,
      direction: dto.direction,
      confidenceScore: dto.confidenceScore,
      suggestedEntryPrice: dto.suggestedEntryPrice,
      suggestedStopLoss: dto.suggestedStopLoss,
      suggestedTakeProfit: dto.suggestedTakeProfit,
      suggestedVolume: dto.suggestedVolume,
      timeframe: dto.timeframe,
      strategyCode: dto.strategyCode,
      marketRegime: dto.marketRegime,
      volatilityScore: dto.volatilityScore,
      generatedAt: dto.generatedAt ? new Date(dto.generatedAt) : new Date(),
      modelVersion: dto.modelVersion,
      metadata: { ...dto.metadata, source: 'python-ai-engine' },
    };

    return this.aiSignalService.receiveSignal(candidate);
  }

  /**
   * INTERNAL: Receive an EXIT decision from the Python AI Engine (§10).
   *
   * Protected by InternalApiKeyGuard — requires x-irexpro-internal-api-key header.
   * Routes through the SERIALIZED exit pipeline — session gate → signal
   * identity gate → per-user serialization → closeTrade(AI_CLOSE_SIGNAL).
   * Exits are risk-reducing: they never enter the NEW-exposure pipeline and
   * are never blocked by emergency execution controls or the market-safety
   * gate (de-risking must stay possible during anomalies).
   *
   * POST /api/v1/ai/internal/exit-signals
   */
  @Post('internal/exit-signals')
  @Public()
  @UseGuards(InternalApiKeyGuard)
  @ApiOperation({
    summary: '[INTERNAL] Receive an EXIT decision from the Python AI Engine',
    description:
      'Service-to-service endpoint for the Python AI Engine. Protected by internal ' +
      'API key (x-irexpro-internal-api-key). Exits close open positions through the ' +
      '§10 serialized pipeline — risk-reducing, never blocked by emergency controls.',
  })
  @ApiHeader({
    name: INTERNAL_API_KEY_HEADER,
    description: 'Internal service API key',
    required: true,
  })
  async receiveInternalExitSignal(
    @Body() dto: InternalExitSignalDto,
  ): Promise<AiExitResult> {
    this.logger.log(
      `[INTERNAL] Exit signal received from AI engine: ` +
        `instrument=${dto.instrument}` +
        (dto.tradeId ? ` trade=${dto.tradeId}` : ' (flatten instrument)') +
        ` user=${dto.userId}`,
    );

    return this.aiSignalService.receiveExitSignal({
      signalId: dto.signalId ?? uuidv4(),
      userId: dto.userId,
      tradingSessionId: dto.tradingSessionId,
      instrument: dto.instrument,
      tradeId: dto.tradeId ?? null,
      confidenceScore: dto.confidenceScore,
      generatedAt: dto.generatedAt ? new Date(dto.generatedAt) : new Date(),
      strategyCode: dto.strategyCode ?? null,
      modelVersion: dto.modelVersion ?? null,
      rationale: dto.rationale ?? null,
    });
  }
}
