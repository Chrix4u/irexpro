import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LivePaperMarketDataService } from '../../broker/services/live-paper-market-data.service';
import { PaperBrokerStateService } from '../../broker/services/paper-broker-state.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const DEFAULT_BRIDGE_INTERVAL_MS = 5_000;
const MAX_PROVIDER_MARK_AGE_MS = 90_000;

/**
 * Fast valuation/protection-mark bridge for PAPER positions.
 *
 * The MetaApi quote collector already samples the configured broker-native
 * source account into market_data.provider_quote_candles. This service reuses
 * those persisted bid/ask samples for PAPER mark-to-market so the Live Account
 * can refresh current price/P&L independently of the 10-minute strategy scan.
 *
 * Safety boundary: these PROVIDER marks may trigger SL/TP for already-open PAPER
 * positions, but they never drive entries, entry fills, sizing, margin authority
 * or model evidence. Closed-M5 replay remains the recovery path for missed ticks.
 */
@Injectable()
export class PaperPositionMarkBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperPositionMarkBridgeService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastSourceTimestampByInstrument = new Map<string, number>();
  private readonly announcedInstruments = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly paperState: PaperBrokerStateService,
    private readonly store: ProviderQuoteCandleStoreService,
    private readonly livePaperMarket: LivePaperMarketDataService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) return;
    const initial = setTimeout(() => void this.collectOnce(), 1_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.collectOnce(), DEFAULT_BRIDGE_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('PAPER position mark bridge enabled source=MetaApi sampled quotes cadence=5s');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collectOnce(now = new Date()): Promise<void> {
    if (this.busy || !this.enabled()) return;
    this.busy = true;
    try {
      const paperConnectionId = this.paperConnectionId();
      const sourceConnectionId = this.sourceConnectionId();
      if (!paperConnectionId || !sourceConnectionId) return;

      const state = await this.paperState.load(paperConnectionId);
      const positions = Array.isArray(state?.positions) ? state.positions : [];
      const instruments = [
        ...new Set(
          positions
            .map((raw) =>
              raw &&
              typeof raw === 'object' &&
              typeof (raw as { instrument?: unknown }).instrument === 'string'
                ? (raw as { instrument: string }).instrument.trim().toUpperCase()
                : '',
            )
            .filter(Boolean),
        ),
      ];

      for (const instrument of instruments) {
        const quote = await this.store.getLatestQuote(sourceConnectionId, instrument);
        if (!quote) continue;
        const observedAt = new Date(quote.timestamp);
        const ageMs = now.getTime() - observedAt.getTime();
        if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > MAX_PROVIDER_MARK_AGE_MS) continue;

        const lastApplied = this.lastSourceTimestampByInstrument.get(instrument) ?? 0;
        if (observedAt.getTime() <= lastApplied) continue;

        this.livePaperMarket.updateProviderQuote(
          instrument,
          quote.bid,
          quote.ask,
          observedAt,
          paperConnectionId,
        );
        this.lastSourceTimestampByInstrument.set(instrument, observedAt.getTime());
        if (!this.announcedInstruments.has(instrument)) {
          this.announcedInstruments.add(instrument);
          this.logger.log(
            `PAPER position mark bridge active instrument=${instrument} sourceObservedAt=${observedAt.toISOString()}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`PAPER position mark bridge deferred: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      this.config.get<string>('METAAPI_QUOTE_COLLECTION_ENABLED', 'false') === 'true' &&
      Boolean(this.paperConnectionId()) &&
      Boolean(this.sourceConnectionId())
    );
  }

  private paperConnectionId(): string {
    return this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
  }

  private sourceConnectionId(): string {
    return this.config.get<string>('multimodelBrokerExpert.sourceConnectionId', '').trim();
  }
}
