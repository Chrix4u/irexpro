import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { OHLCV } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
import { DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2 } from '../../ai/demo-focused-instruments';
import { isFxWeeklySessionOpen } from '../utils/fx-weekly-session';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const DEFAULT_INTERVAL_MS = 15_000;
const BROKER_SOURCE_RESOLVE_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_LIVE_QUOTE_INTERVAL_MS = 1_000;
const MIN_LIVE_QUOTE_INTERVAL_MS = 500;
const MAX_LIVE_QUOTE_INTERVAL_MS = 10_000;
const EXECUTION_SPREAD_MAX_AGE_MS = 5 * 60_000;
const MAX_PROVIDER_CLOCK_AHEAD_MS = 5_000;
const DEFAULT_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
const M1_WARM_TARGET = 600;
const M1_REFRESH_COUNT = 60;
const CONTEXT_REFRESH_COUNT = 40;
const M1_REQUESTS_PER_CYCLE = 3;
// Keep the exact 3 M1 + 1 provider-native context history requests per
// 15-second cycle. Maintain M5 and M15's existing 6/16 share each, but
// prioritize H1's newly completed hourly context: three H1 slots and one H4
// slot in 16 cycles (previously two H1 and two H4). With six pairs this
// refreshes every pair's H1 at most every 32 slots (~8m by default) instead
// of 48 (~12m), while H4 still refreshes every 96 slots (~24m), well inside
// its four-hour completed-bar horizon. Never synthesize missing broker bars.
// The one-context-request limit still protects cTrader Open API rate limits.
const CONTEXT_REFRESH_ROTATION = [
  'M5',
  'M15',
  'M5',
  'M15',
  'M5',
  'M15',
  'H1',
  'H1',
  'M5',
  'M15',
  'M5',
  'M15',
  'M5',
  'M15',
  'H1',
  'H4',
] as const;

/**
 * Exact-binding cTrader market-data collector for the M1 tactical PAPER sleeve.
 *
 * Execution remains bound to the configured PAPER connection. This service is
 * read-only against the separately configured cTrader connection and writes
 * broker-native evidence under that source connection id. M1 is retained at
 * broker-native minute granularity while M5/M15/H1/H4 are also warmed directly;
 * this preserves cTrader no-tick semantics without fabricating aggregate bars.
 *
 * Historical trendbars intentionally contain NO invented bid/ask spread. Live
 * cTrader quotes must independently build the positive-spread evidence required
 * by M1 governance before PAPER execution can be admitted.
 */
@Injectable()
export class CTraderQuoteCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CTraderQuoteCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private liveQuoteTimer: NodeJS.Timeout | null = null;
  private running = false;
  private liveQuoteRunning = false;
  private stopping = false;
  private m1RotationOffset = 0;
  private historyCycleCount = 0;
  private contextRotationOffset = 0;
  private readonly contextInstrumentOffsets = {
    M5: 0,
    M15: 0,
    H1: 0,
    H4: 0,
  };
  // Dedicated per-timeframe fair-share cursors: prioritize the three DEMO
  // entry pairs but never starve the other three broker-native research pairs.
  // Only active for the exact 3+3 instrument cohort, not arbitrary broker
  // configurations or another user's custom instrument set.
  private readonly contextGroupCount = { M5: 0, M15: 0, H1: 0, H4: 0 };
  private readonly focusedContextOffsets = { M5: 0, M15: 0, H1: 0, H4: 0 };
  private readonly researchContextOffsets = { M5: 0, M15: 0, H1: 0, H4: 0 };
  private readonly warnedAt = new Map<string, number>();
  /** Last completed broker-native history persistence, not just request initiation. */
  private readonly lastSuccessfulCollectAt = new Map<string, string>();
  private readonly historicalRefreshFailures = new Map<string, number>();
  /** Read-only provenance: a successful request can still return old candles. */
  private readonly latestBrokerClosedBarAt = new Map<string, string>();
  private readonly staleHistoricalResponses = new Map<string, number>();
  private sourceResolution: { connectionId: string; resolvedAtMs: number } | null = null;

  getHistoricalCollectionStatus(): {
    lastSuccessfulCollectAt: Record<string, string>;
    historicalRefreshFailures: Record<string, number>;
    latestBrokerClosedBarAt: Record<string, string>;
    staleHistoricalResponses: Record<string, number>;
  } {
    return {
      lastSuccessfulCollectAt: Object.fromEntries(this.lastSuccessfulCollectAt),
      historicalRefreshFailures: Object.fromEntries(this.historicalRefreshFailures),
      latestBrokerClosedBarAt: Object.fromEntries(this.latestBrokerClosedBarAt),
      staleHistoricalResponses: Object.fromEntries(this.staleHistoricalResponses),
    };
  }

  private recordContextFreshness(
    connectionId: string,
    instrument: string,
    timeframe: 'M1' | (typeof CONTEXT_REFRESH_ROTATION)[number],
    rows: OHLCV[],
    now: Date,
    timeframeMinutes: number,
  ): void {
    const key = `${instrument}:${timeframe}`;
    const newestMs = Math.max(...rows.map((row) => new Date(row.timestamp).getTime()));
    if (!Number.isFinite(newestMs)) return;
    this.latestBrokerClosedBarAt.set(key, new Date(newestMs).toISOString());
    // No synthetic candles or bypass: old provider history remains old even
    // when the HTTP/OpenAPI request itself successfully completed.
    const stale = now.getTime() - newestMs > 2 * timeframeMinutes * 60_000;
    if (!stale) {
      this.staleHistoricalResponses.delete(key);
      return;
    }
    this.staleHistoricalResponses.set(key, (this.staleHistoricalResponses.get(key) ?? 0) + 1);
    this.warnThrottled(
      `${connectionId}:${key}:stale-provider-history`,
      `cTrader broker-native ${timeframe} returned stale closed history ` +
        `connection=${connectionId} instrument=${instrument} ` +
        `latestClosedBar=${new Date(newestMs).toISOString()} ` +
        `ageMinutes=${Math.floor((now.getTime() - newestMs) / 60_000)}; ` +
        'M1/M5/M15 readiness remains fail-closed.',
    );
  }

  private collectHistorySucceeded(instrument: string, timeframe: string, now: Date): void {
    const key = `${instrument}:${timeframe}`;
    this.lastSuccessfulCollectAt.set(key, now.toISOString());
    this.historicalRefreshFailures.delete(key);
  }

  private collectHistoryFailed(instrument: string, timeframe: string): void {
    const key = `${instrument}:${timeframe}`;
    this.historicalRefreshFailures.set(key, (this.historicalRefreshFailures.get(key) ?? 0) + 1);
  }

  constructor(
    private readonly config: ConfigService,
    private readonly brokerService: BrokerService,
    private readonly store: ProviderQuoteCandleStoreService,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    const intervalMs = this.intervalMs();
    const liveQuoteIntervalMs = this.liveQuoteIntervalMs();
    this.stopping = false;
    this.logger.log(
      `cTrader broker-native M1 collection enabled historyInterval=${intervalMs}ms ` +
        `liveQuoteInterval=${liveQuoteIntervalMs}ms source=${this.sourceConnectionId()} ` +
        `instruments=${this.instruments().join(',')}`,
    );
    this.schedule(intervalMs, 3_000);
    this.scheduleLiveQuotes(liveQuoteIntervalMs, 250);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.liveQuoteTimer) clearTimeout(this.liveQuoteTimer);
    this.timer = null;
    this.liveQuoteTimer = null;
  }

  async collectOnce(now = new Date()): Promise<void> {
    if (this.running || !this.enabled() || !isFxWeeklySessionOpen(now)) return;
    const userId = this.userId();
    if (!userId) return;

    this.running = true;
    const connectionId = await this.resolveCollectionConnectionId(userId);
    if (!connectionId) {
      this.running = false;
      return;
    }
    try {
      const connection = await this.brokerService.findConnectionById(connectionId, userId);
      if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) {
        this.warnThrottled(
          `${connectionId}:wrong-provider`,
          `Configured M1 source ${connectionId} is ${connection.brokerId}, not a cTrader-family broker; collection is fail-closed.`,
        );
        return;
      }
      if (connection.status !== BrokerConnectionStatus.CONNECTED) {
        this.warnThrottled(
          `${connectionId}:not-connected`,
          `Configured cTrader M1 source ${connectionId} is ${connection.status}; collection is paused.`,
        );
        return;
      }

      // Execution-grade bid/ask evidence has priority over historical backfill.
      // A slow/rate-limited OHLCV request must never starve fresh quote samples
      // used by M1 readiness, cross-currency sizing and final risk validation.
      // Quote and history lanes must not block each other's progress. The
      // dedicated live-quote loop remains independently active as well.
      await Promise.all([
        this.sampleLiveSpreads(userId, connectionId),
        this.refreshHistoricalSlice(userId, connectionId, now),
      ]);
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:binding`,
        `cTrader M1 source binding is unavailable: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async collectLiveQuotesOnce(now = new Date()): Promise<void> {
    if (this.liveQuoteRunning || !this.enabled() || !isFxWeeklySessionOpen(now)) return;
    const userId = this.userId();
    if (!userId) return;

    this.liveQuoteRunning = true;
    const connectionId = await this.resolveCollectionConnectionId(userId);
    if (!connectionId) {
      this.liveQuoteRunning = false;
      return;
    }
    try {
      const connection = await this.brokerService.findConnectionById(connectionId, userId);
      if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) return;
      if (connection.status !== BrokerConnectionStatus.CONNECTED) return;
      await this.sampleLiveSpreads(userId, connectionId);
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:live-quote`,
        `cTrader live quote sampling deferred connection=${connectionId}: ${(error as Error).message}`,
      );
    } finally {
      this.liveQuoteRunning = false;
    }
  }

  /**
   * The configured source remains the default research account. While DEMO
   * users trial another cTrader account, collect from the latest FULL_AUTO
   * cTrader session (active first, then most recently ended), even when AI is
   * stopped. This prepares that exact broker's M1/M5/M15/H1/H4 history for
   * charting and future execution without ever moving source rows across
   * connection IDs. Read-only, user-scoped and cached to avoid 1 Hz DB reads.
   */
  private async resolveCollectionConnectionId(userId: string): Promise<string> {
    const configuredSource = this.sourceConnectionId();
    if (!this.dataSource) return configuredSource;
    const now = Date.now();
    if (
      this.sourceResolution &&
      now - this.sourceResolution.resolvedAtMs >= 0 &&
      now - this.sourceResolution.resolvedAtMs < BROKER_SOURCE_RESOLVE_INTERVAL_MS
    ) {
      return this.sourceResolution.connectionId;
    }

    try {
      const rows: Array<{ connectionId: string }> = await this.dataSource.query(
        `SELECT s.broker_connection_id AS "connectionId"
         FROM trading.trading_sessions s
         JOIN broker.broker_connections b
           ON b.id = s.broker_connection_id AND b.user_id = s.user_id
         WHERE s.user_id = $1
           AND s.execution_mode = 'FULL_AUTO'
           AND s.started_at >= NOW() - INTERVAL '7 days'
           AND b.account_type = 'DEMO'
           AND b.status = 'CONNECTED'
           AND b.broker_id = ANY($2::text[])
         ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC
         LIMIT 1`,
        [userId, [...CTRADER_FAMILY_BROKER_IDS]],
      );
      const selected = String(rows[0]?.connectionId ?? '').trim();
      const connectionId = selected || configuredSource;
      if (this.sourceResolution?.connectionId !== connectionId) {
        // Per-pair status keys are intentionally compatibility-preserving.
        // Clear old-account observations so status cannot imply that the
        // newly selected account already has fresh broker-native bars.
        this.lastSuccessfulCollectAt.clear();
        this.historicalRefreshFailures.clear();
        this.latestBrokerClosedBarAt.clear();
        this.staleHistoricalResponses.clear();
        this.logger.log(
          `cTrader M1 collection source selected connection=${connectionId} ` +
            `reason=${selected ? 'RECENT_FULL_AUTO_DEMO_SESSION' : 'CONFIGURED_DEFAULT'}`,
        );
      }
      this.sourceResolution = { connectionId, resolvedAtMs: now };
      return connectionId;
    } catch (error) {
      this.warnThrottled(
        'm1-collection-session-source-unavailable',
        `Unable to resolve latest broker session for cTrader collection: ${(error as Error).message}; configured source retained.`,
      );
      // A transient DB failure must not redirect a previously selected broker
      // to an unverified session; the default account remains explicit.
      return configuredSource;
    }
  }

  private async refreshHistoricalSlice(
    userId: string,
    connectionId: string,
    now: Date,
  ): Promise<void> {
    const instruments = this.instruments();
    if (instruments.length === 0) return;
    const focused = instruments.filter((instrument) =>
      DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.includes(instrument),
    );
    const research = instruments.filter(
      (instrument) => !DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.includes(instrument),
    );
    // Historical 3+3 focus uses a separate prioritized cadence. With all six
    // configurations retain the original round-robin behavior.
    const prioritize = focused.length === 3 && research.length === 3;
    const groupCycle = this.historyCycleCount++;
    // The active six-pair DEMO policy uses the equal-turn round-robin path.
    // Historical 3+3 prioritized scans are kept for reproducible research.
    // The independent live bid/ask loop still covers all six every second.
    // Never suppress a broker quote or synthesize missing bars.
    const m1Instruments = prioritize ? (groupCycle % 4 === 3 ? research : focused) : instruments;
    const m1Count = Math.min(M1_REQUESTS_PER_CYCLE, m1Instruments.length);
    const m1Batch = Array.from(
      { length: m1Count },
      (_, index) => m1Instruments[(this.m1RotationOffset + index) % m1Instruments.length]!,
    );
    // For 3+3, both pools are exactly three, so the offset is immaterial.
    // For all other configurations retain the original round-robin cursor.
    this.m1RotationOffset = (this.m1RotationOffset + m1Count) % m1Instruments.length;

    // Keep the same three M1 + one context historical calls per cycle. The
    // H1/M5/M15/H4 rotation is untouched. Under V2 all six pairs share
    // fair turn-taking; M5/M15 must still satisfy strict freshness limits.
    const timeframe =
      CONTEXT_REFRESH_ROTATION[this.contextRotationOffset % CONTEXT_REFRESH_ROTATION.length]!;
    this.contextRotationOffset = (this.contextRotationOffset + 1) % CONTEXT_REFRESH_ROTATION.length;
    const contextResearchTurn = prioritize && this.contextGroupCount[timeframe]++ % 4 === 3;
    const contextInstruments = prioritize
      ? contextResearchTurn
        ? research
        : focused
      : instruments;
    const offsets = prioritize
      ? contextResearchTurn
        ? this.researchContextOffsets
        : this.focusedContextOffsets
      : this.contextInstrumentOffsets;
    const instrumentOffset = offsets[timeframe] % contextInstruments.length;
    const context = { instrument: contextInstruments[instrumentOffset]!, timeframe };
    offsets[timeframe] = (instrumentOffset + 1) % contextInstruments.length;

    // All provider requests are independent; slow research history must not
    // block the cTrader live quote lane or postpone the focused M1 refresh.
    const m1Tasks = m1Batch.map((instrument) =>
      this.refreshM1(userId, connectionId, instrument, now),
    );
    await Promise.all([
      ...m1Tasks,
      this.refreshContext(userId, connectionId, context.instrument, context.timeframe, now),
    ]);
  }

  private async refreshM1(
    userId: string,
    connectionId: string,
    instrument: string,
    now: Date,
  ): Promise<void> {
    try {
      const existing = await this.store.countM1Candles(connectionId, instrument);
      const requestCount = existing < M1_WARM_TARGET ? M1_WARM_TARGET : M1_REFRESH_COUNT;
      const rows = await this.brokerService.getOhlcvForConnection(
        userId,
        connectionId,
        instrument,
        'M1',
        requestCount,
      );
      const closed = this.closedRows(rows, 1, now);
      if (closed.length > 0) {
        await this.store.upsertHistoricalCandles(
          connectionId,
          instrument,
          'M1',
          closed,
          'ctrader-broker-native',
        );
        this.collectHistorySucceeded(instrument, 'M1', now);
        this.recordContextFreshness(connectionId, instrument, 'M1', closed, now, 1);
      }
    } catch (error) {
      this.collectHistoryFailed(instrument, 'M1');
      this.warnThrottled(
        `${connectionId}:${instrument}:M1`,
        `cTrader M1 refresh deferred connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
      );
    }
  }

  private async refreshContext(
    userId: string,
    connectionId: string,
    instrument: string,
    timeframe: (typeof CONTEXT_REFRESH_ROTATION)[number],
    now: Date,
  ): Promise<void> {
    const minutes =
      timeframe === 'M5' ? 5 : timeframe === 'M15' ? 15 : timeframe === 'H1' ? 60 : 240;
    let lastError: unknown = null;
    // Single bounded retry for a failed historical context request. Only
    // historical OHLCV is retried; independent live quotes remain unaffected.
    // The broker adapter enforces the 5-requests/second historical rate limit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rows = await this.brokerService.getOhlcvForConnection(
          userId,
          connectionId,
          instrument,
          timeframe,
          CONTEXT_REFRESH_COUNT,
        );
        const closed = this.closedRows(rows, minutes, now);
        if (closed.length > 0) {
          await this.store.upsertHistoricalCandles(
            connectionId,
            instrument,
            timeframe,
            closed,
            'ctrader-broker-native',
          );
          this.collectHistorySucceeded(instrument, timeframe, now);
          this.recordContextFreshness(connectionId, instrument, timeframe, closed, now, minutes);
        }
        return;
      } catch (error) {
        lastError = error;
        this.collectHistoryFailed(instrument, timeframe);
      }
    }
    this.warnThrottled(
      `${connectionId}:${instrument}:${timeframe}`,
      `cTrader ${timeframe} refresh deferred after one retry connection=${connectionId} instrument=${instrument}: ${(lastError as Error).message}`,
    );
  }

  private closedRows(rows: OHLCV[], minutes: number, now: Date): OHLCV[] {
    const decisionMs = now.getTime();
    const durationMs = minutes * 60_000;
    return rows.filter((row) => {
      const openMs = new Date(row.timestamp).getTime();
      return Number.isFinite(openMs) && openMs + durationMs <= decisionMs;
    });
  }

  private async sampleLiveSpreads(userId: string, connectionId: string): Promise<void> {
    const quoteStatuses = await Promise.all(
      this.instruments().map(async (instrument) => {
        try {
          const quote = await this.brokerService.getCurrentPriceForConnection(
            userId,
            connectionId,
            instrument,
            { propagateProviderError: true },
          );
          if (!quote) return false;

          // Compare against receipt time, not the collection-cycle start.
          // Spotware can return a newer broker timestamp after a delayed
          // subscription response; rejecting it against the start clock
          // incorrectly labels valid quotes as future-dated. This does not
          // extend the allowed age or future-clock tolerance.
          const receivedAtMs = Date.now();
          const providerTimestampMs = new Date(quote.timestamp).getTime();
          const ageMs = receivedAtMs - providerTimestampMs;
          if (
            !Number.isFinite(providerTimestampMs) ||
            !Number.isFinite(receivedAtMs) ||
            ageMs > EXECUTION_SPREAD_MAX_AGE_MS ||
            ageMs < -MAX_PROVIDER_CLOCK_AHEAD_MS
          ) {
            const ageSeconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1_000) : null;
            this.warnThrottled(
              `${connectionId}:${instrument}:stale-quote`,
              `cTrader live quote rejected connection=${connectionId} instrument=${instrument} ` +
                `providerTimestamp=${new Date(quote.timestamp).toISOString()} ` +
                `ageSeconds=${ageSeconds ?? 'INVALID'}; execution spread remains fail-closed.`,
            );
            return false;
          }

          await this.store.upsertM1Sample(connectionId, instrument, quote, 'ctrader-broker-native');
          return true;
        } catch (error) {
          this.warnThrottled(
            `${connectionId}:${instrument}:quote`,
            `cTrader quote collection failed connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
          );
          return false;
        }
      }),
    );
    // Broker APIs can return no usable quote across all symbols without throwing.
    // Report this provider gap, but never synthesize a candle or relax readiness.
    if (quoteStatuses.length > 0 && quoteStatuses.every((accepted) => accepted === false)) {
      this.warnThrottled(
        `${connectionId}:no-usable-live-quotes`,
        `cTrader provided no usable fresh live quotes for ${quoteStatuses.length} configured pairs; ` +
          'broker-native execution spread and M1 readiness remain fail-closed.',
      );
    }
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      this.config.get<boolean>('vpsForexScanner.m1CtraderCollectionEnabled', false) === true &&
      Boolean(this.userId()) &&
      Boolean(this.sourceConnectionId())
    );
  }

  private userId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }

  private sourceConnectionId(): string {
    return this.config.get<string>('vpsForexScanner.m1MarketDataConnectionId', '').trim();
  }

  private intervalMs(): number {
    const raw = Number(
      this.config.get<number | string>(
        'vpsForexScanner.m1CtraderCollectionIntervalMs',
        DEFAULT_INTERVAL_MS,
      ),
    );
    if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(raw)));
  }

  private liveQuoteIntervalMs(): number {
    const raw = Number(
      this.config.get<number | string>(
        'vpsForexScanner.m1CtraderLiveQuoteIntervalMs',
        DEFAULT_LIVE_QUOTE_INTERVAL_MS,
      ),
    );
    if (!Number.isFinite(raw)) return DEFAULT_LIVE_QUOTE_INTERVAL_MS;
    return Math.min(
      MAX_LIVE_QUOTE_INTERVAL_MS,
      Math.max(MIN_LIVE_QUOTE_INTERVAL_MS, Math.floor(raw)),
    );
  }

  private instruments(): string[] {
    const raw = this.config.get<string>(
      'vpsForexScanner.m1CtraderCollectionInstruments',
      DEFAULT_INSTRUMENTS.join(','),
    );
    const values = raw
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    return values.length > 0 ? [...new Set(values)] : [...DEFAULT_INSTRUMENTS];
  }

  private schedule(intervalMs: number, delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          await this.collectOnce();
        } finally {
          if (!this.stopping) {
            this.schedule(intervalMs, Math.max(1_000, intervalMs - (Date.now() - startedAt)));
          }
        }
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private scheduleLiveQuotes(intervalMs: number, delayMs: number): void {
    if (this.stopping) return;
    this.liveQuoteTimer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          await this.collectLiveQuotesOnce();
        } finally {
          if (!this.stopping) {
            this.scheduleLiveQuotes(
              intervalMs,
              Math.max(100, intervalMs - (Date.now() - startedAt)),
            );
          }
        }
      },
      Math.max(0, delayMs),
    );
    this.liveQuoteTimer.unref?.();
  }

  private warnThrottled(key: string, message: string): void {
    const now = Date.now();
    const previous = this.warnedAt.get(key) ?? 0;
    if (now - previous < 60_000) return;
    this.warnedAt.set(key, now);
    this.logger.warn(message);
  }
}
