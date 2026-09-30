import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { ExternalProviderSignalDto } from './dto/external-provider-signal.dto';
// Round 6 live-execution completion (§10): the internal exit-signal intake.
import { InternalExitSignalDto } from './dto/internal-exit-signal.dto';
import { StrategyResult } from '../strategy/interfaces/strategy.interface';
import { AiExitResult } from '../strategy/interfaces/ai-exit-signal.interface';
import { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { createHash } from 'crypto';
import {
  ExternalSignalApiKeyGuard,
  EXTERNAL_SIGNAL_API_KEY_HEADER,
} from '../../common/guards/external-signal-api-key.guard';

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
      agentContext: dto.agentContext ?? null,
      metadata: { ...dto.metadata, source: 'python-ai-engine' },
    };

    return this.aiSignalService.receiveSignal(candidate);
  }

  /**
   * EXTERNAL PROVIDER: receive a normalized strategy signal from a trusted
   * provider relay. The provider key authenticates only the relay. It grants
   * no trading authority: StrategyOrchestrator independently forces these
   * candidates onto an internal PAPER_ONLY paper-broker session.
   *
   * POST /api/v1/ai/external/signals
   */
  @Post('external/signals')
  @Public()
  @UseGuards(ExternalSignalApiKeyGuard)
  @ApiOperation({
    summary: '[EXTERNAL PROVIDER] Receive PAPER-only signal candidate',
    description:
      'Trusted-provider relay intake. Signals remain PAPER_ONLY until provider certification. ' +
      'Every candidate still passes Strategy Orchestrator → Risk Engine → Execution Engine.',
  })
  @ApiHeader({
    name: EXTERNAL_SIGNAL_API_KEY_HEADER,
    description: 'External provider relay API key',
    required: true,
  })
  async receiveExternalSignal(@Body() dto: ExternalProviderSignalDto): Promise<StrategyResult> {
    const generatedAt = new Date(dto.generatedAt);
    const now = Date.now();
    const generatedMs = generatedAt.getTime();
    if (!Number.isFinite(generatedMs)) {
      throw new BadRequestException('Invalid generatedAt');
    }
    if (generatedMs > now + 30_000) {
      throw new BadRequestException('Signal generatedAt is too far in the future');
    }
    if (now - generatedMs > 120_000) {
      throw new BadRequestException('External signal is stale (maximum age is 120 seconds)');
    }

    if (dto.expiresAt) {
      const expiresAt = new Date(dto.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new BadRequestException('External signal is expired');
      }
      if (expiresAt <= generatedMs || expiresAt - generatedMs > 600_000) {
        throw new BadRequestException('expiresAt must be after generatedAt and within 10 minutes');
      }
    }

    // Stable provider event identity: provider retries map to the same signal
    // and the existing durable AiSignalIdentity gate performs exact replay/
    // conflict handling. No retry may mint a fresh logical trade decision.
    const externalSignalNamespace = 'e1f0c1a2-8d5b-4c3a-9f11-7a9a5e4c2d10';
    const signalId = uuidv5(`${dto.providerCode}|${dto.externalSignalId}`, externalSignalNamespace);

    const rawStrategyCode = `external-${dto.providerCode}-${dto.strategyCode}`;
    const durableStrategyCode =
      rawStrategyCode.length <= 100
        ? rawStrategyCode
        : `${rawStrategyCode.slice(0, 83)}-${createHash('sha256')
            .update(rawStrategyCode)
            .digest('hex')
            .slice(0, 16)}`;

    const candidate: AiSignalCandidate = {
      signalId,
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
      strategyCode: durableStrategyCode,
      generatedAt,
      modelVersion: `external-provider/${dto.providerCode}/paper-only-v1`,
      metadata: {
        signal_source: 'EXTERNAL_PROVIDER',
        external_provider_code: dto.providerCode,
        external_provider_event_id_hash: createHash('sha256')
          .update(dto.externalSignalId)
          .digest('hex'),
        external_provider_paper_only: true,
        production_eligible: false,
        ...(dto.sourceReference ? { source_reference: dto.sourceReference } : {}),
      },
    };

    this.logger.log(
      `[EXTERNAL PROVIDER] PAPER-only candidate provider=${dto.providerCode} ` +
        `instrument=${dto.instrument} direction=${dto.direction} signal=${signalId}`,
    );
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
  async receiveInternalExitSignal(@Body() dto: InternalExitSignalDto): Promise<AiExitResult> {
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
