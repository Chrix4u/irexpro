import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { LivePaperMarketDataService } from '../../broker/services/live-paper-market-data.service';
import { PaperBrokerStateService } from '../../broker/services/paper-broker-state.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const DEFAULT_BRIDGE_INTERVAL_MS = 5_000;
const DEFAULT_PROTECTION_INTERVAL_MS = 1_000;
const MAX_PROVIDER_MARK_AGE_MS = 90_000;

/**
 * Fast valuation/protection-mark bridge for PAPER positions.
 *
 * The MetaApi quote collector already samples the configured broker-native
 * source account into market_data.provider_quote_candles. This service reuses
 * those persisted bid/ask samples for PAPER mark-to-market so the Live Account
 * can refresh current price/P&L independently of the strategy scan.
 *
 * Safety boundary: these PROVIDER/STREAM marks may trigger SL/TP for already-open
 * PAPER positions, but they never drive entries, entry fills, sizing, margin
 * authority or model evidence. Closed-M5 replay remains the recovery path for
 * missed ticks/restarts.
 */
@Injectable()
export class PaperPositionMarkBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperPositionMarkBridgeService.name);
  private timer: NodeJS.Timeout | null = null;
  private protectionTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private protectionBusy = false;
  private lastSourceTimestampByInstrument = new Map<string, number>();
  private readonly announcedInstruments = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly paperState: PaperBrokerStateService,
    private readonly store: ProviderQuoteCandleStoreService,
    private readonly livePaperMarket: LivePaperMarketDataService,
    private readonly brokerAdapters: BrokerAdapterRegistry,
  ) {}

  onModuleInit(): void {
    const providerBridgeEnabled = this.enabled();
    const protectionEnabled = this.protectionEnabled();
    if (!providerBridgeEnabled && !protectionEnabled) return;

    if (providerBridgeEnabled) {
      const initial = setTimeout(() => void this.collectOnce(), 1_000);
      initial.unref?.();
      this.timer = setInterval(() => void this.collectOnce(), DEFAULT_BRIDGE_INTERVAL_MS);
      this.timer.unref?.();
      this.logger.log(
        'PAPER provider execution/mark bridge enabled source=STREAM/MetaApi sampled quotes cadence=5s',
      );
    }

    if (protectionEnabled) {
      this.protectionTimer = setInterval(
        () => void this.protectOnce(),
        DEFAULT_PROTECTION_INTERVAL_MS,
      );
      this.protectionTimer.unref?.();
      this.logger.log(
        'PAPER fast protection heartbeat enabled cadence=1s source=cached live marks',
      );
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.protectionTimer) clearInterval(this.protectionTimer);
    this.timer = null;
    this.protectionTimer = null;
  }

  async protectOnce(): Promise<void> {
    if (this.protectionBusy || !this.protectionEnabled()) return;
    this.protectionBusy = true;
    try {
      const paperConnectionId = this.paperConnectionId();
      if (!paperConnectionId) return;
      const adapter = this.brokerAdapters.getAdapterForConnection(
        paperConnectionId,
        'paper-broker',
      );
      await adapter.getOpenPositions();
    } catch (error) {
      this.logger.debug(`PAPER fast protection heartbeat deferred: ${(error as Error).message}`);
    } finally {
      this.protectionBusy = false;
    }
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
      const openInstruments = new Set(
        positions
          .map((raw) =>
            raw &&
            typeof raw === 'object' &&
            typeof (raw as { instrument?: unknown }).instrument === 'string'
              ? (raw as { instrument: string }).instrument.trim().toUpperCase()
              : '',
          )
          .filter(Boolean),
      );

      // Prime broker-native executable quotes for all six PAPER instruments,
      // not only instruments that already have an open position. The store
      // returns the latest provider mid with a conservative spread equal to
      // max(current spread, rolling positive-spread P90). This prevents zero
      // spread fills while avoiding the stale hard-coded PAPER spread floor.
      const instruments = [...this.livePaperMarket.instruments];
      for (const instrument of instruments) {
        const quote = await this.store.getLatestPositiveSpreadQuote(
          sourceConnectionId,
          instrument,
          now,
        );
        if (!quote) continue;
        const observedAt = new Date(quote.timestamp);
        const ageMs = now.getTime() - observedAt.getTime();
        const positiveAgeMs = now.getTime() - quote.latestPositiveSampleAt.getTime();
        if (
          !Number.isFinite(ageMs) ||
          ageMs < -5_000 ||
          ageMs > MAX_PROVIDER_MARK_AGE_MS ||
          !Number.isFinite(positiveAgeMs) ||
          positiveAgeMs < -5_000 ||
          positiveAgeMs > 5 * 60_000 ||
          quote.positiveSampleCount < 10
        ) {
          continue;
        }

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
            `PAPER provider execution/mark bridge active instrument=${instrument} ` +
              `sourceObservedAt=${observedAt.toISOString()} positiveSamples=${quote.positiveSampleCount}`,
          );
        }
      }

      // Protection must never depend on a browser polling the open-positions
      // endpoint. Every 5-second server heartbeat asks the connection-scoped
      // PAPER adapter to evaluate whichever fresh STREAM/PROVIDER mark is
      // currently available. getOpenPositions() applies and persists PAPER
      // protection before returning. If the adapter is not connected yet
      // during bootstrap, defer silently; the scanner will connect the same
      // isolated session.
      if (openInstruments.size > 0) {
        try {
          const adapter = this.brokerAdapters.getAdapterForConnection(
            paperConnectionId,
            'paper-broker',
          );
          await adapter.getOpenPositions();
        } catch (error) {
          this.logger.debug(`PAPER protection heartbeat deferred: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`PAPER position mark bridge deferred: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private protectionEnabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      Boolean(this.paperConnectionId())
    );
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
