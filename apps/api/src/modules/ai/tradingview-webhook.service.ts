import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v5 as uuidv5 } from 'uuid';
import { AiSignalService } from './ai-signal.service';
import { TradingViewWebhookSignalDto } from './dto/tradingview-webhook-signal.dto';
import { ExecutionService } from '../execution/execution.service';
import { StrategyResult } from '../strategy/interfaces/strategy.interface';

const TV_SIGNAL_NAMESPACE = '0aa7f0a1-83de-4bf6-b40e-b95888f5592e';

@Injectable()
export class TradingViewWebhookService {
  constructor(
    private readonly configService: ConfigService,
    private readonly aiSignalService: AiSignalService,
    private readonly executionService: ExecutionService,
  ) {}

  async receive(dto: TradingViewWebhookSignalDto): Promise<StrategyResult> {
    const userId = this.configService.get<string>('tradingViewWebhook.userId')?.trim();
    if (!userId) {
      throw new ServiceUnavailableException('TradingView PAPER binding is not configured');
    }

    const generatedAt = new Date(dto.generatedAt);
    const generatedMs = generatedAt.getTime();
    const now = Date.now();
    if (!Number.isFinite(generatedMs)) throw new BadRequestException('Invalid generatedAt');
    if (generatedMs > now + 30_000)
      throw new BadRequestException('Signal generatedAt is too far in the future');
    if (now - generatedMs > 120_000)
      throw new BadRequestException('TradingView signal is stale (maximum age is 120 seconds)');

    if (dto.expiresAt) {
      const expiresAt = new Date(dto.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= now)
        throw new BadRequestException('TradingView signal is expired');
      if (expiresAt <= generatedMs || expiresAt - generatedMs > 600_000) {
        throw new BadRequestException('expiresAt must be after generatedAt and within 10 minutes');
      }
    }

    const session = await this.executionService.getActiveSession(userId);
    if (!session) {
      throw new ServiceUnavailableException(
        'No active PAPER trading session is available for TradingView',
      );
    }

    const signalId = uuidv5(`tradingview|${dto.eventId}`, TV_SIGNAL_NAMESPACE);
    return this.aiSignalService.receiveSignal({
      signalId,
      userId,
      tradingSessionId: session.id,
      brokerConnectionId: session.brokerConnectionId,
      instrument: dto.instrument,
      direction: dto.direction,
      confidenceScore: dto.confidence,
      suggestedEntryPrice: dto.entryPrice,
      suggestedStopLoss: dto.stopLoss,
      suggestedTakeProfit: dto.takeProfit,
      suggestedVolume: dto.suggestedVolume ?? 0.01,
      timeframe: dto.timeframe,
      strategyCode: `external-tradingview-${dto.strategy}`.slice(0, 100),
      marketRegime: dto.marketRegime,
      volatilityScore: dto.volatilityScore,
      generatedAt,
      modelVersion: 'external-provider/tradingview-six-pair-v1/paper-only-v1',
      metadata: {
        signal_source: 'EXTERNAL_PROVIDER',
        external_provider_code: 'tradingview-six-pair-v1',
        external_provider_paper_only: true,
        production_eligible: false,
        tradingview_event_id: dto.eventId,
      },
    });
  }
}
