/**
 * CTraderAdapter — cTrader Open API integration (Sprint 56 / Task 47-C2;
 * re-integrated onto the Sprint 50/51 IBrokerAdapter contract as Task 48-B).
 *
 * Implements IBrokerAdapter over the CTraderClientService JSON-WebSocket
 * connection manager. This adapter stays a MAPPING layer: every protocol
 * interaction (auth, heartbeat, rate limits, reconnect) lives in the client
 * service; every value conversion (volume cents, 1/100000 spot prices,
 * moneyDigits money) lives in ctrader-message-types.ts as pure helpers.
 *
 * NEW-MAIN CONTRACT NOTES (Task 48-B):
 * - NO `capabilities` field: capabilities live in the broker catalog
 *   (registry/broker-catalog.ts — Directive §M). The adapter only implements.
 * - Order kinds use `orderKind` ('MARKET'|'LIMIT'|'STOP'|'STOP_LIMIT') +
 *   `timeInForce` ('GTC'|'DAY'|'IOC'|'FOK') unions (Sprint 50 PR-3), NOT a
 *   BrokerOrderType enum. Non-market kinds are validated fail-closed — never
 *   silently downgraded.
 * - `clientOrderId` (caller-supplied stable identifier) rides the cTrader
 *   clientOrderId field (proto ≤50 chars, FIX ClOrderID semantics) together
 *   with the idempotencyKey in label (≤100) + comment (≤512).
 * - `listOrders()`/`getOrderById()` implement the Sprint 50 PR-4 provider
 *   order-state read surface (BrokerOrderState): working orders via
 *   ProtoOAReconcileReq (2124 — the provider's pending-order snapshot),
 *   single orders (INCLUDING completed ones) via ProtoOAOrderDetailsReq
 *   (2181).
 * - `filledQuantity` is reported on BrokerOrderResult whenever the provider
 *   reports a filled volume (ProtoOAExecutionEvent 2126 carries it).
 * - AdapterMetadata (Directive §AL/§AM) is implemented — informational only.
 * - `cancelOrder(...)` is KEPT as an ADDITIVE CONCRETE method (not part of
 *   IBrokerAdapter — see its comment).
 *
 * CREDENTIAL MAPPING (documented, one place):
 * - DecryptedBrokerCredentials.apiKey        → the user's cTrader OAuth
 *   ACCESS TOKEN (obtained via the id.ctrader.com consent flow — see
 *   ctrader-oauth.ts; refresh tokens are optional in additionalParams).
 * - DecryptedBrokerCredentials.accountId    → the ctidTraderAccountId
 *   (string form of the int64 global cTrader account id).
 * - DecryptedBrokerCredentials.additionalParams.refreshToken → optional
 *   non-expiring OAuth refresh token (never logged, never persisted).
 * - BrokerOrderRequest.connectionReference / RequiredMarginParams
 *   .connectionReference → the ctidTraderAccountId of the account to route
 *   to (memory-only, same semantics as the MetaTrader adapter).
 *
 * DEMO/LIVE HOST ISOLATION (hard invariant): the adapter mode selects the
 * environment; the client service then connects to exactly
 * wss://demo.ctraderapi.com:5036 or wss://live.ctraderapi.com:5036 — never
 * the other. connect() additionally verifies via account discovery (2149)
 * that the account's isLive flag MATCHES the selected environment.
 *
 * SECURITY INVARIANTS:
 * - Access tokens are memory-only (client session map); NEVER logged.
 * - All money/prices/volumes in adapter OUTPUTS are decimal STRINGS
 *   (BigInt/string math in ctrader-message-types.ts — never floats).
 * - idempotencyKey propagates into clientOrderId + label + comment
 *   (proto limits 50/100/512 chars, truncated safely).
 * - Fail-closed everywhere: unknown message shapes → typed
 *   BROKER_SERVER_ERROR; not-connected → NOT_CONNECTED.
 *
 * PROTOCOL NOTES (honest limitations, verified against the .proto set):
 * - MARKET orders cannot carry absolute SL/TP on ProtoOANewOrderReq (proto:
 *   "Not supported for MARKET orders") — SL/TP for MARKET orders are
 *   attached to the FILLED POSITION via ProtoOAAmendPositionSLTPReq (2110).
 *   If that amend fails, the adapter THROWS: the fill is real but the
 *   position is unprotected — the ExecutionService marks the trade
 *   RECONCILIATION_PENDING and the reconciliation job re-syncs from the
 *   position state (never a dishonest success).
 * - Deal-list pagination chunk semantics are not officially documented
 *   (worklog 47-B1 flag) — pagination advances fromTimestamp past the last
 *   returned deal (ascending assumption) and is hard-capped at 100 pages.
 * - cTrader deals carry no close reason and no position-open timestamp —
 *   closeReason is reported honestly as UNKNOWN.
 * - ProtoOAReconcileRes's `order` field is the provider's PENDING-order
 *   snapshot (proto comment) — exactly the working-order surface
 *   listOrders() must expose; completed orders are only reachable through
 *   getOrderById (ProtoOAOrderDetailsReq).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AdapterMetadata,
  BrokerAccountInfo,
  BrokerBalance,
  BrokerCloseAllResult,
  BrokerClosedTrade,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerOrderModification,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
  RequiredMarginParams,
} from '../../interfaces/broker-adapter.interface';
import type { OrderCapabilityDeclaration } from '../../interfaces/order-capability';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import {
  ProviderDispatchCertainty,
  withDefaultCertainty,
} from '../../interfaces/provider-dispatch-certainty';
import { redactString } from '../../../../common/utils/redact-sensitive.util';
import { CTraderClientService } from './ctrader-client.service';
import { assertDiscoveredBrokerIdentity } from './ctrader-broker-identity';
import {
  addDecimalStrings,
  buildIdempotencyFields,
  contractTimeInForceToProto,
  CTRADER_PAYLOAD_TYPE,
  CTRADER_TRENDBAR_PERIODS,
  CtraderDeal,
  CtraderDiscoveredAccount,
  CtraderEnvironment,
  CtraderExecutionEventPayload,
  CtraderMessageEnvelope,
  CtraderOrder,
  CtraderPosition,
  CtraderPositionUnrealizedPnl,
  CtraderSpotEventPayload,
  CtraderSymbol,
  CtraderTimeInForce,
  CtraderTradeSide,
  CtraderExecutionType,
  CtraderOrderType,
  CtraderPositionStatus,
  CtraderOrderStatus,
  CtraderTrader,
  CtraderLightSymbol,
  CtraderAsset,
  decimalStringToWirePrice,
  expectCtraderPayload,
  mapCtraderError,
  moneyToDecimalString,
  parseCtraderId,
  percentageRatioString,
  protoTimeInForceToString,
  spotMidPrice,
  spotToPrice,
  subtractDecimalStrings,
  unitsToVolumeCents,
  volumeCentsToLotString,
  wirePriceToDecimalString,
} from './ctrader-message-types';

/** Cap on deal-list pagination (infinite-loop guard, documented). */
const MAX_DEAL_LIST_PAGES = 100;
/** Page size for deal-list requests (within the 5 req/s historical budget). */
const DEAL_LIST_MAX_ROWS = 200;
/** Trendbar lookback multiplier (headroom so `count` bars are returned). */
const TRENDBAR_LOOKBACK_FACTOR = 2;

interface SymbolCache {
  /** normalized instrument name (e.g. "EURUSD") → symbolId */
  readonly nameToId: Map<string, number>;
  readonly idToName: Map<number, string>;
  readonly details: Map<number, CtraderSymbol>;
  symbolsLoaded: boolean;
}

interface AdapterSession {
  readonly env: CtraderEnvironment;
  readonly accountId: string;
  /** Memory-only OAuth access token — never logged, never persisted. */
  readonly accessToken: string;
  readonly symbols: SymbolCache;
  readonly assets: Map<number, string>;
}

function emptySymbolCache(): SymbolCache {
  return {
    nameToId: new Map<string, number>(),
    idToName: new Map<number, string>(),
    details: new Map<number, CtraderSymbol>(),
    symbolsLoaded: false,
  };
}

function normalizeInstrumentName(instrument: string): string {
  return instrument.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Milliseconds per trendbar period (for the lookback window). */
const TRENDBAR_PERIOD_MS: Readonly<Record<number, number>> = {
  1: 60_000,
  2: 120_000,
  3: 180_000,
  4: 240_000,
  5: 300_000,
  6: 600_000,
  7: 900_000,
  8: 1_800_000,
  9: 3_600_000,
  10: 14_400_000,
  11: 43_200_000,
  12: 86_400_000,
  13: 604_800_000,
  14: 2_629_800_000,
};

/**
 * cTrader catalog identity for the DI-managed metadata/root adapter. No
 * provider is ever registered for this token: NestJS injects `undefined`
 * and the constructor default ('ctrader' — the broker-agnostic identity)
 * applies. Isolated instances from the registry factory pass the REQUESTED
 * broker id (alias-aware) explicitly.
 */
const CTRADER_ROOT_BROKER_IDENTITY = Symbol('CTRADER_ROOT_BROKER_IDENTITY');

@Injectable()
export class CTraderAdapter implements IBrokerAdapter, AdapterMetadata {
  private readonly logger = new Logger(CTraderAdapter.name);

  readonly brokerId = 'ctrader';
  readonly brokerName = 'cTrader (Open API)';
  readonly supportsDemo = true;

  // ─── Directive §AL/§AM — operational metadata (informational only) ────────
  /**
   * cTrader Open API — JSON encoding of the official ProtoOA protobuf message
   * catalog over WebSocket (port 5036). Spotware publishes no per-API version
   * string, so the protocol generation is identified by its family.
   */
  readonly providerApiVersion = 'open-api';
  /** Semantic version of this adapter implementation. */
  readonly adapterVersion = '1.0.0';
  /**
   * Conservative OPERATIONAL defaults for metadata/observability, taken from
   * the client service's token-bucket limiter: cTrader publishes 50 req/s per
   * connection (general) with a 50-token burst capacity. The historical class
   * (DealList/OrderList/Trendbars/TickData) is separately limited to 5 req/s
   * — both are ENFORCED client-side, never approximated here.
   */
  readonly rateLimitProfile = { requestsPerSecond: 50, burst: 50 };

  private mode: BrokerMode = BrokerMode.DEMO;
  /**
   * Sessions per ctidTraderAccountId established by THIS adapter context.
   * Correction round 3 (architect findings 1 + 2): each persisted
   * BrokerConnection.id receives its own adapter context from the
   * registry's connection-isolation factory — this map is per-context state,
   * never process-global. Lower-level provider infrastructure (the shared
   * CTraderClientService environment connections) is leased per context via
   * `sessionOwnerKey` (finding 4).
   */
  private readonly sessions = new Map<string, AdapterSession>();
  private currentAccountId: string | null = null;
  /**
   * Unique lease-owner key for the client's account-session refcounting
   * (finding 4). One per adapter context: releasing it releases exactly the
   * provider sessions this context required — never sessions leased by other
   * contexts (other BrokerConnections sharing the account).
   */
  private readonly sessionOwnerKey: string;

  constructor(
    private readonly client: CTraderClientService,
    /**
     * The broker identity this adapter context was created for (alias-aware:
     * 'ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader' — architect
     * finding 2). The canonical provider id stays 'ctrader' (brokerId); the
     * requested identity drives broker-specific identity verification against
     * the discovered brokerTitleShort (finding 6). Public readonly — a broker
     * identity string, never a secret; observable for wiring/contract tests.
     *
     * The DI-managed root adapter resolves this through an @Optional token
     * nobody provides → undefined → the 'ctrader' default applies (the root
     * is the broker-agnostic metadata instance). Factory-created isolated
     * instances pass the REQUESTED id positionally.
     */
    @Optional()
    @Inject(CTRADER_ROOT_BROKER_IDENTITY)
    readonly requestedBrokerId: string = 'ctrader',
  ) {
    this.sessionOwnerKey = `ctrader-adapter-${randomUUID()}`;
  }

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  async connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    try {
      const accessToken = this.requireAccessToken(credentials);
      const accountId = String(credentials.accountId);
      parseCtraderId(accountId, 'accountId'); // fail-closed on garbage ids
      const env: CtraderEnvironment = this.mode === BrokerMode.LIVE ? 'LIVE' : 'DEMO';

      // App auth (2100 FIRST) + account auth (2102) — fails closed with a
      // clear message when platform cTrader app credentials are unconfigured.
      // The session is LEASED to this adapter context (finding 4): other
      // contexts sharing the same account keep their sessions alive.
      await this.client.ensureAccountSession(env, accountId, accessToken, this.sessionOwnerKey);

      // Account discovery (2149): verify the account's isLive flag MATCHES
      // the selected environment — the account-level host-isolation guard.
      // Broker-identity verification (finding 6): the discovered brand must
      // match the REQUESTED alias when one was selected.
      const discovered = await this.client.discoverAccounts(env, accessToken);
      const account = this.verifyAccountEnvironment(discovered, accountId, env);
      assertDiscoveredBrokerIdentity(this.requestedBrokerId, account);

      const session: AdapterSession = {
        env,
        accountId,
        accessToken,
        symbols: emptySymbolCache(),
        assets: new Map<number, string>(),
      };
      this.sessions.set(accountId, session);
      this.currentAccountId = accountId;

      const trader = await this.fetchTrader(session);
      const currency = await this.resolveCurrency(session, trader);

      return {
        success: true,
        accountId,
        accountType: env === 'LIVE' ? BrokerMode.LIVE : BrokerMode.DEMO,
        currency,
        serverTime: new Date(),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async disconnect(): Promise<void> {
    // Lease semantics (findings 1 + 4): release every provider-session lease
    // THIS adapter context holds. Provider sessions still required by other
    // BrokerConnection contexts sharing the same cTrader account/environment
    // survive; the last release tears down the provider session and, when the
    // environment goes idle, the shared transport itself.
    await this.releaseAllContextSessions();
  }

  /**
   * Releases all account-session leases owned by this adapter context and
   * clears its local session state. Idempotent; used by disconnect() and the
   * credential-test finally path (finding 5).
   */
  private async releaseAllContextSessions(): Promise<void> {
    this.sessions.clear();
    this.currentAccountId = null;
    await this.client.releaseOwnerSessions(this.sessionOwnerKey);
  }

  async testConnection(
    credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    // Credential tests run on EPHEMERAL adapter contexts (BrokerService uses
    // registry.createEphemeralAdapter — finding 7). Every provider session
    // such a context establishes is TEMPORARY: disposal runs in a finally
    // path so partial failures (2102 succeeded then discovery/trader fetch
    // failed) can never leak a session, and lease refcounting guarantees
    // sessions owned by PERSISTED connections sharing the same account are
    // never invalidated (finding 5).
    let result: BrokerConnectionTestResult;
    try {
      const connected = await this.connect(credentials);
      result = {
        success: true,
        accountId: connected.accountId,
        accountType: connected.accountType,
        // Round 6 (#7): unknown currency stays unknown — null (unreported by
        // the provider) maps to undefined at this non-authoritative test
        // seam; it NEVER becomes a fabricated 'USD'.
        currency: connected.currency ?? undefined,
      };
    } catch (err) {
      const mapped = this.mapError(err);
      result = { success: false, errorCode: mapped.code, errorMessage: mapped.message };
    } finally {
      try {
        await this.releaseAllContextSessions();
      } catch (disposeErr) {
        // Disposal failures must never mask the test outcome (sanitized warn
        // only — the finally path stays exception-safe).
        this.logger.warn(
          `Credential-test session disposal failed: ${(disposeErr as Error).message}`,
        );
      }
    }
    return result;
  }

  isConnected(): boolean {
    const accountId = this.currentAccountId;
    if (!accountId) return false;
    const session = this.sessions.get(accountId);
    if (!session) return false;
    return this.client.hasAccountSession(session.env, session.accountId);
  }

  // ─── Account state ────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    const session = this.requireCurrentSession();
    try {
      const trader = await this.fetchTrader(session);
      const currency = await this.resolveCurrency(session, trader);
      const balance = moneyToDecimalString(trader.balance, trader.moneyDigits ?? 2);
      const leverage = Math.floor((trader.leverageInCents ?? 0) / 100);

      const positions = await this.fetchReconcilePositions(session);
      const pnl = await this.fetchUnrealizedPnl(session);
      const totalPnl = this.sumNetPnl(pnl);

      // Margin from the positions' usedMargin (moneyDigits per position).
      let margin = '0';
      for (const position of positions) {
        margin = addDecimalStrings(
          margin,
          moneyToDecimalString(position.usedMargin ?? 0, position.moneyDigits ?? 2),
        );
      }
      const equity = addDecimalStrings(balance, totalPnl);
      const freeMargin = subtractDecimalStrings(equity, margin);
      const marginLevel =
        margin === '0' || margin === '0.00' ? '0' : percentageRatioString(equity, margin);

      return {
        accountId: session.accountId,
        currency,
        leverage,
        balance,
        equity,
        margin,
        freeMargin,
        marginLevel,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    const session = this.requireCurrentSession();
    try {
      const trader = await this.fetchTrader(session);
      const currency = await this.resolveCurrency(session, trader);
      const balance = moneyToDecimalString(trader.balance, trader.moneyDigits ?? 2);
      const pnl = await this.fetchUnrealizedPnl(session);
      const equity = addDecimalStrings(balance, this.sumNetPnl(pnl));
      return { balance, equity, currency, timestamp: new Date() };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const session = this.requireCurrentSession();
    try {
      const positions = await this.fetchReconcilePositions(session);
      return await this.enrichPositions(session, positions);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    const session = this.requireCurrentSession();
    try {
      const positions = await this.fetchReconcilePositions(session);
      const match = positions.find((p) => String(p.positionId) === externalOrderId);
      if (!match) return null;
      const [position] = await this.enrichPositions(session, [match]);
      return position ?? null;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    // Sprint 32 Gate 2 contract: null whenever the margin cannot be safely
    // computed — the Risk Engine then fails closed.
    try {
      const session = this.resolveSession(params.connectionReference);
      if (!session) return null;

      const symbolId = await this.resolveSymbolId(session, params.instrument);
      if (symbolId === null) return null;
      const symbol = await this.resolveSymbolDetails(session, symbolId);
      if (!symbol || !symbol.lotSize) return null;

      let volumeCents: number;
      try {
        volumeCents = unitsToVolumeCents(params.lotSize, symbol.lotSize);
      } catch {
        return null;
      }

      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_REQ,
        {
          ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
          symbolId,
          volume: [volumeCents],
        },
      );
      const payload = expectCtraderPayload<{
        margin?: Array<{ volume?: number; buyMargin?: number; sellMargin?: number }>;
        moneyDigits?: number;
      }>(response, CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_RES);
      const entry = Array.isArray(payload.margin) ? payload.margin[0] : undefined;
      if (!entry) return null;
      const rawMargin = params.direction === 'BUY' ? entry.buyMargin : entry.sellMargin;
      if (rawMargin === undefined || rawMargin === null) return null;
      return moneyToDecimalString(rawMargin, payload.moneyDigits ?? 2);
    } catch {
      return null;
    }
  }

  // ─── Market data ──────────────────────────────────────────────────────────

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    const session = this.requireCurrentSession();
    try {
      const lightSymbols = await this.fetchSymbolsList(session);
      const symbolIds = lightSymbols.map((s) => s.symbolId);
      const details = symbolIds.length > 0 ? await this.fetchSymbolDetails(session, symbolIds) : [];
      const instruments: BrokerInstrument[] = [];
      for (const light of lightSymbols) {
        const symbol = details.find((d) => d.symbolId === light.symbolId);
        // Symbols without a lotSize cannot be traded through the normalized
        // contract — excluded honestly instead of reporting fake volumes.
        if (!symbol?.lotSize) continue;
        instruments.push({
          symbol: light.symbolName ?? String(light.symbolId),
          description: light.description ?? light.symbolName ?? String(light.symbolId),
          digits: symbol.digits ?? 5,
          minLot: volumeCentsToLotString(symbol.minVolume ?? 0, symbol.lotSize),
          maxLot: volumeCentsToLotString(symbol.maxVolume ?? 0, symbol.lotSize),
          lotStep: volumeCentsToLotString(symbol.stepVolume ?? 0, symbol.lotSize),
          contractSize: moneyToDecimalString(symbol.lotSize, 2),
        });
      }
      return instruments;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    const session = this.requireCurrentSession();
    try {
      const symbolId = await this.resolveSymbolIdOrThrow(session, instrument);
      const spot = await this.fetchSpotQuote(session, symbolId);
      const bid = spotToPrice(spot.bid ?? 0);
      const ask = spotToPrice(spot.ask ?? 0);
      return {
        instrument,
        bid,
        ask,
        spread: subtractDecimalStrings(ask, bid),
        timestamp: spot.timestamp ? new Date(spot.timestamp) : new Date(),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    const session = this.requireCurrentSession();
    try {
      const symbolId = await this.resolveSymbolIdOrThrow(session, instrument);
      const period = CTRADER_TRENDBAR_PERIODS[timeframe.toUpperCase()];
      if (!period) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          `Timeframe "${timeframe}" is not supported by the cTrader adapter.`,
        );
      }
      const periodMs = TRENDBAR_PERIOD_MS[period] ?? 60_000;
      const to = Date.now();
      const from = to - Math.max(count, 1) * periodMs * TRENDBAR_LOOKBACK_FACTOR;
      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_REQ,
        {
          ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
          fromTimestamp: from,
          toTimestamp: to,
          period,
          symbolId,
          count: Math.max(1, Math.floor(count)),
        },
      );
      const payload = expectCtraderPayload<{
        trendbar?: Array<{
          volume?: number;
          low?: number;
          deltaOpen?: number;
          deltaClose?: number;
          deltaHigh?: number;
          utcTimestampInMinutes?: number;
        }>;
      }>(response, CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_RES);
      const bars = Array.isArray(payload.trendbar) ? payload.trendbar : [];
      return bars.map((bar) => {
        const low = bar.low ?? 0;
        return {
          timestamp: new Date((bar.utcTimestampInMinutes ?? 0) * 60_000),
          open: spotToPrice(low + (bar.deltaOpen ?? 0)),
          high: spotToPrice(low + (bar.deltaHigh ?? 0)),
          low: spotToPrice(low),
          close: spotToPrice(low + (bar.deltaClose ?? 0)),
          volume: String(bar.volume ?? 0),
        };
      });
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Order management ─────────────────────────────────────────────────────

  // ─── Order capability contract (Round 6 §7) ──────────────────────────────

  /**
   * cTrader capability matrix (the DECLARED truth): all four normalized
   * kinds; LIMIT/STOP_LIMIT need limitPrice, STOP/STOP_LIMIT need stopPrice.
   * MARKET orders do NOT carry SL/TP on the wire — protection is attached
   * to the FILLED position (proto 2110 amend) — so
   * marketSlTpAttachedAtPlacement is FALSE and §8's protective loop covers
   * the deferred-attach shape.
   */
  getOrderCapabilities(): OrderCapabilityDeclaration {
    return {
      brokerId: this.brokerId,
      supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
      requirements: {
        MARKET: { limitPriceRequired: false, stopPriceRequired: false },
        LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
        STOP: { limitPriceRequired: false, stopPriceRequired: true },
        STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
      },
      marketSlTpAttachedAtPlacement: false,
    };
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const session = this.resolveSession(order.connectionReference);
    if (!session) throw this.notConnected();
    try {
      // Fail-closed order-kind dispatch (Sprint 50 PR-3): never silently
      // downgrade a non-market kind. All four normalized kinds are supported
      // by the ProtoOANewOrderReq surface.
      const kind = order.orderKind ?? 'MARKET';
      if (kind !== 'MARKET' && kind !== 'LIMIT' && kind !== 'STOP' && kind !== 'STOP_LIMIT') {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          `Unsupported order kind: ${String(kind)}`,
        );
      }
      // Price validation BEFORE any request (fail-fast, MT-adapter style).
      if (
        (kind === 'LIMIT' || kind === 'STOP_LIMIT') &&
        !this.isPositiveDecimal(order.limitPrice)
      ) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_PRICE,
          'LIMIT order requires a positive decimal limitPrice',
        );
      }
      if ((kind === 'STOP' || kind === 'STOP_LIMIT') && !this.isPositiveDecimal(order.stopPrice)) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_PRICE,
          'STOP order requires a positive decimal stopPrice',
        );
      }

      const symbolId = await this.resolveSymbolIdOrThrow(session, order.instrument);
      const symbol = await this.resolveSymbolDetails(session, symbolId);
      if (!symbol?.lotSize) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_INSTRUMENT,
          `Symbol "${order.instrument}" has no lot size — refusing to convert the volume.`,
        );
      }
      const volumeCents = unitsToVolumeCents(order.lotSize, symbol.lotSize);
      const idem = buildIdempotencyFields(order.idempotencyKey);
      // Client-order-id wiring (Sprint 50 PR-3): a caller-supplied stable
      // identifier takes the proto clientOrderId slot (FIX ClOrderID
      // semantics, ≤50 chars); otherwise the idempotencyKey occupies it —
      // label (≤100) + comment (≤512) always carry the idempotency key.
      const clientOrderId =
        order.clientOrderId !== undefined && order.clientOrderId !== ''
          ? order.clientOrderId.slice(0, 50)
          : idem.clientOrderId;
      const ctid = parseCtraderId(session.accountId, 'ctidTraderAccountId');
      const protoOrderType = this.mapOrderKindToProto(kind);

      // Time-in-force mapping: explicit contract value first; protocol-safe
      // defaults otherwise (MARKET → IOC, resting orders → GTC).
      const protoTif =
        order.timeInForce !== undefined
          ? contractTimeInForceToProto(order.timeInForce)
          : protoOrderType === CtraderOrderType.MARKET
            ? CtraderTimeInForce.IMMEDIATE_OR_CANCEL
            : CtraderTimeInForce.GOOD_TILL_CANCEL;

      const payload: Record<string, unknown> = {
        ctidTraderAccountId: ctid,
        symbolId,
        orderType: protoOrderType,
        tradeSide: order.direction === 'BUY' ? CtraderTradeSide.BUY : CtraderTradeSide.SELL,
        volume: volumeCents,
        timeInForce: protoTif,
        clientOrderId,
        label: idem.label,
        comment: idem.comment,
      };
      // DAY time-in-force → GOOD_TILL_DATE needs an expiration timestamp:
      // the end of the current UTC trading day (proto field 6, Unix ms).
      if (protoTif === CtraderTimeInForce.GOOD_TILL_DATE) {
        payload.expirationTimestamp = this.nextUtcMidnightMs();
      }
      // Absolute limit/stop prices (protocol doubles) for pending orders.
      if (
        protoOrderType === CtraderOrderType.LIMIT ||
        protoOrderType === CtraderOrderType.STOP_LIMIT
      ) {
        payload.limitPrice = decimalStringToWirePrice(order.limitPrice ?? '', 'limitPrice');
      }
      if (
        protoOrderType === CtraderOrderType.STOP ||
        protoOrderType === CtraderOrderType.STOP_LIMIT
      ) {
        payload.stopPrice = decimalStringToWirePrice(order.stopPrice ?? '', 'stopPrice');
      }
      // Absolute SL/TP are NOT supported for MARKET orders on the wire (proto
      // comment) — they are attached to the filled position below instead.
      if (protoOrderType !== CtraderOrderType.MARKET) {
        this.applyProtectionPrices(payload, order.stopLoss, order.takeProfit);
      }

      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ,
        payload,
      );

      // ProtoOAOrderErrorEvent (2132) — a typed rejection of OUR request.
      if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
        const errorPayload = (response.payload ?? {}) as {
          errorCode?: string;
          description?: string;
        };
        throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
      }
      if (response.payloadType !== CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT) {
        throw mapCtraderError(
          undefined,
          `Unexpected order response payloadType ${response.payloadType}`,
        );
      }

      const result = this.mapExecutionEventToOrderResult(response, symbol.lotSize);
      // MARKET + SL/TP: attach the protection to the FILLED position (2110).
      if (
        protoOrderType === CtraderOrderType.MARKET &&
        result.status === 'FILLED' &&
        result.externalOrderId &&
        this.hasProtection(order)
      ) {
        await this.amendPositionProtection(session, result.externalOrderId, order);
      }
      return result;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    const session = this.requireCurrentSession();
    try {
      const ctid = parseCtraderId(session.accountId, 'ctidTraderAccountId');
      const { positions, orders } = await this.fetchReconcile(session);

      const asPosition = positions.find((p) => String(p.positionId) === externalOrderId);
      const asOrder = orders.find((o) => String(o.orderId) === externalOrderId);
      if (!asPosition && !asOrder) {
        throw new BrokerAdapterError(
          BrokerErrorCode.POSITION_NOT_FOUND,
          `No open position or working order "${externalOrderId}" on the cTrader account.`,
        );
      }

      let response: CtraderMessageEnvelope;
      if (asPosition) {
        // Amend position SL/TP (2110) — absolute prices.
        response = await this.client.request(
          session.env,
          CTRADER_PAYLOAD_TYPE.AMEND_POSITION_SLTP_REQ,
          this.buildPositionProtectionPayload(
            ctid,
            parseCtraderId(asPosition.positionId, 'positionId'),
            modifications,
          ),
        );
      } else {
        // Amend working order (2109) — SL/TP fields only.
        const payload: Record<string, unknown> = {
          ctidTraderAccountId: ctid,
          orderId: parseCtraderId(asOrder!.orderId, 'orderId'),
        };
        this.applyProtectionPrices(
          payload,
          modifications.newStopLoss ?? '',
          modifications.newTakeProfit ?? '',
        );
        if (modifications.newTrailingStop !== undefined && modifications.newTrailingStop !== '0') {
          payload.trailingStopLoss = true;
        }
        response = await this.client.request(
          session.env,
          CTRADER_PAYLOAD_TYPE.AMEND_ORDER_REQ,
          payload,
        );
      }

      if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
        const errorPayload = (response.payload ?? {}) as {
          errorCode?: string;
          description?: string;
        };
        throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
      }
      const event = expectCtraderPayload<CtraderExecutionEventPayload>(
        response,
        CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      );
      if (event.executionType === CtraderExecutionType.ORDER_REJECTED) {
        return {
          success: false,
          externalOrderId,
          status: 'REJECTED',
          brokerMessage: event.errorCode ?? 'Amendment rejected',
        };
      }
      return {
        success: true,
        externalOrderId,
        status: 'FILLED',
        brokerMessage: `Amended (executionType ${event.executionType})`,
        rawResponse: response.payload,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    const session = this.requireCurrentSession();
    try {
      const positions = await this.fetchReconcilePositions(session);
      const position = positions.find((p) => String(p.positionId) === externalOrderId);
      if (!position) {
        throw new BrokerAdapterError(
          BrokerErrorCode.POSITION_NOT_FOUND,
          `"${externalOrderId}" is not an open position on the cTrader account.`,
        );
      }
      const symbol = await this.resolveSymbolDetails(session, position.tradeData.symbolId);
      if (!symbol?.lotSize) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_INSTRUMENT,
          'Symbol lot size unavailable — cannot convert the close volume.',
        );
      }
      let volumeCents: number;
      if (lotSize !== undefined && lotSize !== '') {
        volumeCents = unitsToVolumeCents(lotSize, symbol.lotSize);
        if (volumeCents > position.tradeData.volume) {
          throw new BrokerAdapterError(
            BrokerErrorCode.INVALID_LOT_SIZE,
            `Close volume ${lotSize} exceeds the open position volume.`,
          );
        }
      } else {
        volumeCents = position.tradeData.volume;
      }
      return await this.closePositionVolume(session, position, volumeCents, symbol.lotSize);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── ADDITIVE CONCRETE SURFACE — NOT part of IBrokerAdapter ───────────────

  /**
   * Cancels a WORKING order through ProtoOACancelOrderReq (2108).
   *
   * ADDITIVE CONCRETE METHOD (Sprint 50/51 contract decision): cancelOrder is
   * deliberately NOT declared on the shared IBrokerAdapter interface. The
   * provider-verification harness narrows with `'cancelOrder' in adapter` to
   * exercise it on adapters that implement it. Do NOT widen the shared
   * interface for this method; do NOT remove it from this adapter.
   */
  async cancelOrder(externalOrderId: string): Promise<BrokerOrderResult> {
    const session = this.requireCurrentSession();
    try {
      const { orders } = await this.fetchReconcile(session);
      const order = orders.find((o) => String(o.orderId) === externalOrderId);
      if (!order) {
        throw new BrokerAdapterError(
          BrokerErrorCode.POSITION_NOT_FOUND,
          `"${externalOrderId}" is not a working order on the cTrader account.`,
        );
      }
      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.CANCEL_ORDER_REQ,
        {
          ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
          orderId: parseCtraderId(order.orderId, 'orderId'),
        },
      );
      if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
        const errorPayload = (response.payload ?? {}) as {
          errorCode?: string;
          description?: string;
        };
        throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
      }
      const event = expectCtraderPayload<CtraderExecutionEventPayload>(
        response,
        CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      );
      if (event.executionType === CtraderExecutionType.ORDER_CANCEL_REJECTED) {
        return {
          success: false,
          externalOrderId,
          status: 'REJECTED',
          brokerMessage: event.errorCode ?? 'Cancellation rejected',
        };
      }
      return {
        success: true,
        externalOrderId,
        status: 'FILLED',
        brokerMessage: `Cancelled (executionType ${event.executionType})`,
        rawResponse: response.payload,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    const session = this.requireCurrentSession();
    let closedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];
    try {
      const positions = await this.fetchReconcilePositions(session);
      // Sequential closes respect the 50 req/s connection budget.
      for (const position of positions) {
        try {
          const symbol = await this.resolveSymbolDetails(session, position.tradeData.symbolId);
          if (!symbol?.lotSize) {
            throw new BrokerAdapterError(
              BrokerErrorCode.INVALID_INSTRUMENT,
              'Symbol lot size unavailable — cannot convert the close volume.',
            );
          }
          const result = await this.closePositionVolume(
            session,
            position,
            position.tradeData.volume,
            symbol.lotSize,
          );
          if (result.success) closedCount++;
          else {
            failedCount++;
            errors.push(`${position.positionId}: ${result.brokerMessage ?? 'failed'}`);
          }
        } catch (err) {
          failedCount++;
          const mapped = this.mapError(err);
          errors.push(`${position.positionId}: ${mapped.message}`);
        }
      }
    } catch (err) {
      const mapped = this.mapError(err);
      errors.push(mapped.message);
    }
    return { closedCount, failedCount, errors };
  }

  // ─── Trade history ────────────────────────────────────────────────────────

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    const session = this.requireCurrentSession();
    try {
      await this.fetchSymbolsList(session);
      const ctid = parseCtraderId(session.accountId, 'ctidTraderAccountId');
      const trades: BrokerClosedTrade[] = [];
      let pageFrom = from.getTime();
      const toMs = to.getTime();

      for (let page = 0; page < MAX_DEAL_LIST_PAGES; page++) {
        const response = await this.client.request(
          session.env,
          CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ,
          {
            ctidTraderAccountId: ctid,
            fromTimestamp: pageFrom,
            toTimestamp: toMs,
            maxRows: DEAL_LIST_MAX_ROWS,
          },
        );
        const payload = expectCtraderPayload<{
          deal?: CtraderDeal[];
          hasMore?: boolean;
        }>(response, CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES);
        const deals = Array.isArray(payload.deal) ? payload.deal : [];
        const closingDeals = deals.filter((deal) => deal?.closePositionDetail !== undefined);

        for (const deal of closingDeals) {
          trades.push(await this.mapClosedDeal(session, deal));
        }

        if (payload.hasMore !== true || deals.length === 0) {
          break;
        }
        // Advance past the last returned deal (ascending-order assumption;
        // chunk semantics are not officially documented — hard page cap above).
        const lastTimestamp = deals[deals.length - 1].executionTimestamp;
        pageFrom = lastTimestamp + 1;
      }
      return trades;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Provider order state (Sprint 50 PR-4 — reconciliation read surface) ──

  /**
   * Working orders from ProtoOAReconcileReq (2124): the provider's pending
   * order snapshot — pending LIMIT/STOP/STOP_LIMIT orders plus transient
   * states, exactly the WORKING set the contract requires (completed orders
   * are NOT included; they are reachable through getOrderById).
   *
   * Protection orders (STOP_LOSS_TAKE_PROFIT, MARKET_RANGE) and symbols
   * without a lot size stay OUT of the normalized surface — reported
   * honestly by omission (never by fabricated quantities), mirroring the
   * orphan's documented behavior.
   */
  async listOrders(): Promise<BrokerOrderState[]> {
    const session = this.requireCurrentSession();
    try {
      await this.fetchSymbolsList(session);
      const { orders } = await this.fetchReconcile(session);
      const states: BrokerOrderState[] = [];
      for (const order of orders) {
        // WORKING surface only (contract: no history/completed orders) —
        // ACCEPTED covers pending + in-flight + partially-filled-still-working.
        if (order.orderStatus !== CtraderOrderStatus.ORDER_STATUS_ACCEPTED) continue;
        if (this.mapProtoOrderKind(order.orderType) === null) continue; // protection orders
        const symbol = await this.resolveSymbolDetails(session, order.tradeData.symbolId);
        if (!symbol?.lotSize) continue;
        states.push(this.mapOrderToState(session, order, symbol.lotSize));
      }
      return states;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Single provider order by id — INCLUDING completed (history) orders — via
   * ProtoOAOrderDetailsReq (2181: "getting Order and its related Deals").
   *
   * null is returned ONLY for a legitimate provider not-found answer (the
   * mapped ORDER_NOT_FOUND error) — never as an error fallback (Directive
   * §AN #7). A malformed response fails closed with BROKER_SERVER_ERROR.
   */
  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    const session = this.requireCurrentSession();
    try {
      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ,
        {
          ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
          orderId: this.orderIdForWire(providerOrderId),
        },
      );
      if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
        const errorPayload = (response.payload ?? {}) as {
          errorCode?: string;
          description?: string;
        };
        throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
      }
      const payload = expectCtraderPayload<{ order?: CtraderOrder; deal?: CtraderDeal[] }>(
        response,
        CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES,
      );
      if (!payload.order) {
        // A 200-style answer without the order object is malformed — NEVER
        // interpreted as "not found" (null is reserved for the provider's
        // legitimate not-found answer, Directive §AN #7).
        throw new BrokerAdapterError(
          BrokerErrorCode.BROKER_SERVER_ERROR,
          'cTrader order-details response is missing the order payload — outcome cannot be recorded.',
        );
      }
      await this.fetchSymbolsList(session);
      const symbol = await this.resolveSymbolDetails(session, payload.order.tradeData.symbolId);
      if (!symbol?.lotSize) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_INSTRUMENT,
          `cTrader order instrument "${payload.order.tradeData.symbolId}" has no lot size — cannot convert quantities honestly.`,
        );
      }
      if (this.mapProtoOrderKind(payload.order.orderType) === null) {
        // Protection/market-range orders are outside the normalized contract.
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          `Provider order "${providerOrderId}" is a protection order — outside the normalized order contract.`,
        );
      }
      return this.mapOrderToState(session, payload.order, symbol.lotSize);
    } catch (err) {
      const mapped = this.mapError(err);
      // null is ONLY allowed for a legitimate provider not-found — never
      // as an error fallback (Directive §AN #7).
      if (mapped.code === BrokerErrorCode.POSITION_NOT_FOUND) return null;
      throw mapped;
    }
  }

  // ─── Internals: session + provider reads ──────────────────────────────────

  private notConnected(): BrokerAdapterError {
    return new BrokerAdapterError(
      BrokerErrorCode.NOT_CONNECTED,
      'No active cTrader connection. Call connect() first.',
      undefined,
      false,
    );
  }

  private requireCurrentSession(): AdapterSession {
    const session = this.resolveSession(undefined);
    if (!session) {
      throw this.notConnected();
    }
    return session;
  }

  /** Session routing: explicit account reference first, current session otherwise. */
  private resolveSession(connectionReference?: string): AdapterSession | null {
    const accountId = connectionReference ?? this.currentAccountId;
    if (!accountId) return null;
    const session = this.sessions.get(accountId);
    if (!session) return null;
    if (!this.client.hasAccountSession(session.env, session.accountId)) {
      return null;
    }
    return session;
  }

  private requireAccessToken(credentials: DecryptedBrokerCredentials): string {
    const token = credentials.apiKey;
    if (!token || token.trim() === '') {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'cTrader connections require the OAuth access token as credentials.apiKey.',
      );
    }
    return token;
  }

  private verifyAccountEnvironment(
    discovered: CtraderDiscoveredAccount[],
    accountId: string,
    env: CtraderEnvironment,
  ): CtraderDiscoveredAccount {
    const account = discovered.find((entry) => String(entry.ctidTraderAccountId) === accountId);
    if (!account) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'The account is not granted to this cTrader access token.',
      );
    }
    const expectedLive = env === 'LIVE';
    if (account.isLive !== expectedLive) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        `The account is a ${account.isLive ? 'LIVE' : 'DEMO'} cTrader account — connect through ` +
          `${account.isLive ? 'LIVE' : 'DEMO'} mode (environments are strictly separated).`,
      );
    }
    return account;
  }

  private async fetchTrader(session: AdapterSession): Promise<CtraderTrader> {
    const response = await this.client.request(session.env, CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
      ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
    });
    const payload = expectCtraderPayload<{ trader?: CtraderTrader }>(
      response,
      CTRADER_PAYLOAD_TYPE.TRADER_RES,
    );
    if (!payload.trader) {
      throw new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        'cTrader account summary response is missing the trader payload.',
      );
    }
    return payload.trader;
  }

  private async resolveCurrency(session: AdapterSession, trader: CtraderTrader): Promise<string> {
    if (session.assets.size === 0) {
      const response = await this.client.request(session.env, CTRADER_PAYLOAD_TYPE.ASSET_LIST_REQ, {
        ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
      });
      const payload = expectCtraderPayload<{ asset?: CtraderAsset[] }>(
        response,
        CTRADER_PAYLOAD_TYPE.ASSET_LIST_RES,
      );
      for (const asset of Array.isArray(payload.asset) ? payload.asset : []) {
        if (asset && typeof asset.assetId === 'number' && typeof asset.name === 'string') {
          session.assets.set(asset.assetId, asset.name);
        }
      }
    }
    const currency = session.assets.get(trader.depositAssetId);
    if (!currency) {
      throw new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        'The account deposit currency could not be resolved from the cTrader asset list.',
      );
    }
    return currency;
  }

  private async fetchReconcile(session: AdapterSession): Promise<{
    positions: CtraderPosition[];
    orders: CtraderOrder[];
  }> {
    const response = await this.client.request(session.env, CTRADER_PAYLOAD_TYPE.RECONCILE_REQ, {
      ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
      returnProtectionOrders: false,
    });
    const payload = expectCtraderPayload<{ position?: CtraderPosition[]; order?: CtraderOrder[] }>(
      response,
      CTRADER_PAYLOAD_TYPE.RECONCILE_RES,
    );
    return {
      positions: Array.isArray(payload.position) ? payload.position : [],
      orders: Array.isArray(payload.order) ? payload.order : [],
    };
  }

  private async fetchReconcilePositions(session: AdapterSession): Promise<CtraderPosition[]> {
    const { positions } = await this.fetchReconcile(session);
    // Only genuinely OPEN positions (POSITION_STATUS_CREATED is an empty shell
    // for pending orders; CLOSED positions are history).
    return positions.filter((p) => p.positionStatus === CtraderPositionStatus.POSITION_STATUS_OPEN);
  }

  private async fetchUnrealizedPnl(
    session: AdapterSession,
  ): Promise<{ entries: CtraderPositionUnrealizedPnl[]; moneyDigits: number }> {
    const response = await this.client.request(
      session.env,
      CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ,
      { ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId') },
    );
    const payload = expectCtraderPayload<{
      positionUnrealizedPnL?: CtraderPositionUnrealizedPnl[];
      moneyDigits?: number;
    }>(response, CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES);
    return {
      entries: Array.isArray(payload.positionUnrealizedPnL) ? payload.positionUnrealizedPnL : [],
      moneyDigits: payload.moneyDigits ?? 2,
    };
  }

  private sumNetPnl(pnl: { entries: CtraderPositionUnrealizedPnl[]; moneyDigits: number }): string {
    let total = '0';
    for (const entry of pnl.entries) {
      total = addDecimalStrings(
        total,
        moneyToDecimalString(entry.netUnrealizedPnL, pnl.moneyDigits),
      );
    }
    return total;
  }

  private async fetchSymbolsList(session: AdapterSession): Promise<CtraderLightSymbol[]> {
    if (session.symbols.symbolsLoaded) {
      return Array.from(session.symbols.idToName.entries()).map(([symbolId, symbolName]) => ({
        symbolId,
        symbolName,
      }));
    }
    const response = await this.client.request(session.env, CTRADER_PAYLOAD_TYPE.SYMBOLS_LIST_REQ, {
      ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
      includeArchivedSymbols: false,
    });
    const payload = expectCtraderPayload<{ symbol?: CtraderLightSymbol[] }>(
      response,
      CTRADER_PAYLOAD_TYPE.SYMBOLS_LIST_RES,
    );
    const symbols = Array.isArray(payload.symbol) ? payload.symbol : [];
    for (const symbol of symbols) {
      const name = symbol.symbolName ?? '';
      session.symbols.nameToId.set(normalizeInstrumentName(name), symbol.symbolId);
      session.symbols.idToName.set(symbol.symbolId, name);
    }
    session.symbols.symbolsLoaded = true;
    return symbols;
  }

  private async fetchSymbolDetails(
    session: AdapterSession,
    symbolIds: number[],
  ): Promise<CtraderSymbol[]> {
    const missing = symbolIds.filter((id) => !session.symbols.details.has(id));
    if (missing.length > 0) {
      const response = await this.client.request(
        session.env,
        CTRADER_PAYLOAD_TYPE.SYMBOL_BY_ID_REQ,
        {
          ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
          symbolId: missing,
        },
      );
      const payload = expectCtraderPayload<{ symbol?: CtraderSymbol[] }>(
        response,
        CTRADER_PAYLOAD_TYPE.SYMBOL_BY_ID_RES,
      );
      for (const symbol of Array.isArray(payload.symbol) ? payload.symbol : []) {
        session.symbols.details.set(symbol.symbolId, symbol);
      }
    }
    return symbolIds
      .map((id) => session.symbols.details.get(id))
      .filter((symbol): symbol is CtraderSymbol => symbol !== undefined);
  }

  private async resolveSymbolId(
    session: AdapterSession,
    instrument: string,
  ): Promise<number | null> {
    await this.fetchSymbolsList(session);
    const symbolId = session.symbols.nameToId.get(normalizeInstrumentName(instrument));
    return symbolId ?? null;
  }

  private async resolveSymbolIdOrThrow(
    session: AdapterSession,
    instrument: string,
  ): Promise<number> {
    const symbolId = await this.resolveSymbolId(session, instrument);
    if (symbolId === null) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `Instrument "${instrument}" was not found on the cTrader account.`,
      );
    }
    return symbolId;
  }

  private async resolveSymbolDetails(
    session: AdapterSession,
    symbolId: number,
  ): Promise<CtraderSymbol | null> {
    const [symbol] = await this.fetchSymbolDetails(session, [symbolId]);
    return symbol ?? null;
  }

  private symbolName(session: AdapterSession, symbolId: number): string {
    return session.symbols.idToName.get(symbolId) ?? String(symbolId);
  }

  /** Subscribe→await one full spot event→unsubscribe (request/response pricing). */
  private async fetchSpotQuote(
    session: AdapterSession,
    symbolId: number,
  ): Promise<CtraderSpotEventPayload> {
    const ctid = parseCtraderId(session.accountId, 'ctidTraderAccountId');
    const eventPromise = this.client.awaitEvent(
      session.env,
      (message) => {
        if (message.payloadType !== CTRADER_PAYLOAD_TYPE.SPOT_EVENT) return false;
        const payload = message.payload as Partial<CtraderSpotEventPayload> | undefined | null;
        // Event correlation (architect finding 3): the spot event must belong
        // to the REQUESTING account AND symbol, with a complete bid/ask
        // quote. A 2131 event for a DIFFERENT account on the same shared
        // environment connection can never satisfy this waiter.
        return (
          payload?.ctidTraderAccountId === ctid &&
          payload?.symbolId === symbolId &&
          payload.bid != null &&
          payload.ask != null
        );
      },
      10_000,
    );
    await this.client.request(session.env, CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: ctid,
      symbolId: [symbolId],
    });
    try {
      const event = await eventPromise;
      return event.payload as unknown as CtraderSpotEventPayload;
    } finally {
      // Best-effort unsubscribe (traffic hygiene; failures are not fatal).
      void this.client
        .request(session.env, CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ, {
          ctidTraderAccountId: ctid,
          symbolId: [symbolId],
        })
        .catch(() => undefined);
    }
  }

  private async enrichPositions(
    session: AdapterSession,
    positions: CtraderPosition[],
  ): Promise<BrokerPosition[]> {
    if (positions.length === 0) return [];
    // Symbol NAMES come from the (cached) symbols list — ensure it is loaded so
    // positions never fall back to bare symbolId strings.
    await this.fetchSymbolsList(session);
    const pnls = await this.fetchUnrealizedPnl(session);
    const pnlByPosition = new Map<number, number>();
    for (const entry of pnls.entries) {
      pnlByPosition.set(entry.positionId, entry.netUnrealizedPnL);
    }
    // One batched SymbolById for every distinct symbol, one spot quote each.
    const symbolIds = Array.from(new Set(positions.map((p) => p.tradeData.symbolId)));
    const symbols = await this.fetchSymbolDetails(session, symbolIds);
    const symbolById = new Map(symbols.map((symbol) => [symbol.symbolId, symbol]));
    const quoteBySymbol = new Map<number, string>();
    for (const symbolId of symbolIds) {
      const spot = await this.fetchSpotQuote(session, symbolId);
      quoteBySymbol.set(symbolId, spotMidPrice(spot.bid ?? 0, spot.ask ?? 0));
    }
    return positions.map((position) => {
      const symbol = symbolById.get(position.tradeData.symbolId);
      const lotSizeCents = symbol?.lotSize;
      const lotSize =
        lotSizeCents !== undefined
          ? volumeCentsToLotString(position.tradeData.volume, lotSizeCents)
          : String(position.tradeData.volume);
      const netPnl = pnlByPosition.get(position.positionId) ?? 0;
      return {
        externalOrderId: String(position.positionId),
        instrument: this.symbolName(session, position.tradeData.symbolId),
        direction: position.tradeData.tradeSide === CtraderTradeSide.BUY ? 'BUY' : 'SELL',
        lotSize,
        openPrice: wirePriceToDecimalString(position.price),
        currentPrice: quoteBySymbol.get(position.tradeData.symbolId) ?? '0',
        stopLoss:
          position.stopLoss !== undefined ? wirePriceToDecimalString(position.stopLoss) : '0',
        takeProfit:
          position.takeProfit !== undefined ? wirePriceToDecimalString(position.takeProfit) : '0',
        unrealisedPnl: moneyToDecimalString(netPnl, pnls.moneyDigits),
        openedAt: position.tradeData.openTimestamp
          ? new Date(position.tradeData.openTimestamp)
          : new Date(),
        commission: moneyToDecimalString(position.commission ?? 0, position.moneyDigits ?? 2),
        swap: moneyToDecimalString(position.swap ?? 0, position.moneyDigits ?? 2),
      };
    });
  }

  private async mapClosedDeal(
    session: AdapterSession,
    deal: CtraderDeal,
  ): Promise<BrokerClosedTrade> {
    const close = deal.closePositionDetail!;
    const symbol = await this.resolveSymbolDetails(session, deal.symbolId);
    const lotSizeCents = symbol?.lotSize;
    const closedVolume = close.closedVolume ?? deal.filledVolume;
    return {
      externalOrderId: String(deal.positionId),
      instrument: this.symbolName(session, deal.symbolId),
      direction: deal.tradeSide === CtraderTradeSide.BUY ? 'BUY' : 'SELL',
      lotSize:
        lotSizeCents !== undefined
          ? volumeCentsToLotString(closedVolume, lotSizeCents)
          : String(closedVolume),
      openPrice: wirePriceToDecimalString(close.entryPrice),
      closePrice: wirePriceToDecimalString(deal.executionPrice),
      stopLoss: '0',
      takeProfit: '0',
      realisedPnl: moneyToDecimalString(close.grossProfit, close.moneyDigits ?? 2),
      // cTrader deals carry no position-open timestamp — execution time used
      // for both (honest limitation, mirrors the MetaTrader deal mapping).
      openedAt: new Date(deal.executionTimestamp),
      closedAt: new Date(deal.executionTimestamp),
      commission: moneyToDecimalString(close.commission, close.moneyDigits ?? 2),
      swap: moneyToDecimalString(close.swap, close.moneyDigits ?? 2),
      closeReason: 'UNKNOWN',
    };
  }

  private async closePositionVolume(
    session: AdapterSession,
    position: CtraderPosition,
    volumeCents: number,
    symbolLotSizeCents?: number,
  ): Promise<BrokerOrderResult> {
    const response = await this.client.request(
      session.env,
      CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ,
      {
        ctidTraderAccountId: parseCtraderId(session.accountId, 'ctidTraderAccountId'),
        positionId: parseCtraderId(position.positionId, 'positionId'),
        volume: volumeCents,
      },
    );
    if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
      const errorPayload = (response.payload ?? {}) as { errorCode?: string; description?: string };
      throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
    }
    const event = expectCtraderPayload<CtraderExecutionEventPayload>(
      response,
      CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
    );
    if (event.executionType === CtraderExecutionType.ORDER_REJECTED) {
      return {
        success: false,
        externalOrderId: String(position.positionId),
        status: 'REJECTED',
        brokerMessage: event.errorCode ?? 'Close rejected',
        rawResponse: response.payload,
      };
    }
    const filled =
      event.executionType === CtraderExecutionType.ORDER_FILLED ||
      event.executionType === CtraderExecutionType.ORDER_PARTIAL_FILL;
    const filledCents = event.deal?.filledVolume;
    return {
      success: filled,
      externalOrderId: String(position.positionId),
      filledPrice: filled ? wirePriceToDecimalString(event.deal?.executionPrice) : undefined,
      // Sprint 50 PR-3: partial closes report the actually-filled quantity.
      filledQuantity:
        filled && filledCents !== undefined && filledCents > 0 && symbolLotSizeCents !== undefined
          ? volumeCentsToLotString(filledCents, symbolLotSizeCents)
          : undefined,
      filledAt:
        filled && event.deal?.executionTimestamp
          ? new Date(event.deal.executionTimestamp)
          : undefined,
      status: filled ? 'FILLED' : 'FAILED',
      brokerMessage: `Close executionType ${event.executionType}`,
      rawResponse: response.payload,
    };
  }

  // ─── Internals: order mapping ─────────────────────────────────────────────

  private mapOrderKindToProto(orderKind: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT'): number {
    switch (orderKind) {
      case 'MARKET':
        return CtraderOrderType.MARKET;
      case 'LIMIT':
        return CtraderOrderType.LIMIT;
      case 'STOP':
        return CtraderOrderType.STOP;
      case 'STOP_LIMIT':
        return CtraderOrderType.STOP_LIMIT;
      default:
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          `Unsupported order kind "${String(orderKind)}".`,
        );
    }
  }

  private mapProtoOrderKind(
    protoOrderType: number,
  ): 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | null {
    switch (protoOrderType) {
      case CtraderOrderType.MARKET:
        return 'MARKET';
      case CtraderOrderType.LIMIT:
        return 'LIMIT';
      case CtraderOrderType.STOP:
        return 'STOP';
      case CtraderOrderType.STOP_LIMIT:
        return 'STOP_LIMIT';
      default:
        return null; // STOP_LOSS_TAKE_PROFIT / MARKET_RANGE protection orders
    }
  }

  /**
   * ProtoOAOrderStatus → BrokerOrderState.status (directive-strict, fail
   * closed): ACCEPTED → WORKING (or PARTIALLY_FILLED when part of the volume
   * has executed and the rest still works); FILLED/REJECTED/EXPIRED/CANCELLED
   * map 1:1; anything else → UNKNOWN (reconciliation must not guess).
   */
  private mapOrderStateStatus(order: CtraderOrder): BrokerOrderState['status'] {
    const requested = order.tradeData.volume;
    const executed = order.executedVolume ?? 0;
    switch (order.orderStatus) {
      case CtraderOrderStatus.ORDER_STATUS_ACCEPTED:
        if (executed > 0 && executed < requested) return 'PARTIALLY_FILLED';
        return 'WORKING';
      case CtraderOrderStatus.ORDER_STATUS_FILLED:
        return 'FILLED';
      case CtraderOrderStatus.ORDER_STATUS_REJECTED:
        return 'REJECTED';
      case CtraderOrderStatus.ORDER_STATUS_EXPIRED:
        return 'EXPIRED';
      case CtraderOrderStatus.ORDER_STATUS_CANCELLED:
        return 'CANCELLED';
      default:
        return 'UNKNOWN';
    }
  }

  /** ProtoOAOrder → BrokerOrderState (the reconciliation read surface). */
  private mapOrderToState(
    session: AdapterSession,
    order: CtraderOrder,
    symbolLotSizeCents: number,
  ): BrokerOrderState {
    const status = this.mapOrderStateStatus(order);
    const orderKind = this.mapProtoOrderKind(order.orderType);
    const requestedQuantity = volumeCentsToLotString(order.tradeData.volume, symbolLotSizeCents);
    const filledQuantity = volumeCentsToLotString(order.executedVolume ?? 0, symbolLotSizeCents);
    const hasFill = status === 'FILLED' || status === 'PARTIALLY_FILLED';
    return {
      providerOrderId: String(order.orderId),
      clientOrderId: order.clientOrderId ?? null,
      status,
      instrument: this.symbolName(session, order.tradeData.symbolId),
      direction: order.tradeData.tradeSide === CtraderTradeSide.BUY ? 'BUY' : 'SELL',
      requestedQuantity,
      filledQuantity,
      // executionPrice is the provider's fill price (VWAP for partial fills
      // per the proto comment "Price at which an order was executed").
      avgFillPrice: hasFill
        ? order.executionPrice !== undefined
          ? wirePriceToDecimalString(order.executionPrice)
          : null
        : null,
      orderKind,
      limitPrice:
        orderKind === 'LIMIT' || orderKind === 'STOP_LIMIT'
          ? order.limitPrice !== undefined
            ? wirePriceToDecimalString(order.limitPrice)
            : null
          : null,
      stopPrice:
        orderKind === 'STOP' || orderKind === 'STOP_LIMIT'
          ? order.stopPrice !== undefined
            ? wirePriceToDecimalString(order.stopPrice)
            : null
          : null,
      timeInForce: protoTimeInForceToString(order.timeInForce),
      placedAt: order.tradeData.openTimestamp ? new Date(order.tradeData.openTimestamp) : null,
      updatedAt: order.utcLastUpdateTimestamp ? new Date(order.utcLastUpdateTimestamp) : null,
      raw: order,
    };
  }

  /**
   * Order ids are provider int64s; numeric ids are safety-checked through
   * parseCtraderId. A NON-numeric identifier cannot exist in the provider's
   * id space — it is passed through verbatim so the PROVIDER (never the
   * adapter) rules on it, surfacing as either a typed error or a legitimate
   * not-found. Production callers only ever pass provider-issued numeric ids
   * (from BrokerOrderResult.externalOrderId / BrokerOrderState).
   */
  private orderIdForWire(providerOrderId: string): number | string {
    try {
      return parseCtraderId(providerOrderId, 'orderId');
    } catch {
      return providerOrderId;
    }
  }

  private hasProtection(order: BrokerOrderRequest): boolean {
    return this.isNonZeroPrice(order.stopLoss) || this.isNonZeroPrice(order.takeProfit);
  }

  private isNonZeroPrice(value: string | undefined): boolean {
    return value !== undefined && value.trim() !== '' && value.trim() !== '0';
  }

  private isPositiveDecimal(value: string | undefined): boolean {
    if (value === undefined) return false;
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return false;
    return parseFloat(trimmed) > 0;
  }

  /** End of the current UTC trading day, in Unix ms (for DAY/GOOD_TILL_DATE). */
  private nextUtcMidnightMs(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  }

  private applyProtectionPrices(
    payload: Record<string, unknown>,
    stopLoss: string | undefined,
    takeProfit: string | undefined,
  ): void {
    if (this.isNonZeroPrice(stopLoss)) {
      payload.stopLoss = decimalStringToWirePrice(stopLoss!, 'stopLoss');
    }
    if (this.isNonZeroPrice(takeProfit)) {
      payload.takeProfit = decimalStringToWirePrice(takeProfit!, 'takeProfit');
    }
  }

  private buildPositionProtectionPayload(
    ctid: number,
    positionId: number,
    modifications: BrokerOrderModification,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { ctidTraderAccountId: ctid, positionId };
    if (this.isNonZeroPrice(modifications.newStopLoss)) {
      payload.stopLoss = decimalStringToWirePrice(modifications.newStopLoss!, 'newStopLoss');
    }
    if (this.isNonZeroPrice(modifications.newTakeProfit)) {
      payload.takeProfit = decimalStringToWirePrice(modifications.newTakeProfit!, 'newTakeProfit');
    }
    if (modifications.newTrailingStop !== undefined && modifications.newTrailingStop !== '0') {
      payload.trailingStopLoss = true;
    }
    return payload;
  }

  /** MARKET-order SL/TP attached to the filled position via 2110. */
  private async amendPositionProtection(
    session: AdapterSession,
    positionId: string,
    order: BrokerOrderRequest,
  ): Promise<void> {
    const response = await this.client.request(
      session.env,
      CTRADER_PAYLOAD_TYPE.AMEND_POSITION_SLTP_REQ,
      this.buildPositionProtectionPayload(
        parseCtraderId(session.accountId, 'ctidTraderAccountId'),
        parseCtraderId(positionId, 'positionId'),
        { newStopLoss: order.stopLoss, newTakeProfit: order.takeProfit },
      ),
    );
    if (response.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT) {
      const errorPayload = (response.payload ?? {}) as { errorCode?: string; description?: string };
      throw mapCtraderError(errorPayload.errorCode, errorPayload.description);
    }
    if (response.payloadType !== CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT) {
      throw mapCtraderError(undefined, 'Unexpected SL/TP amendment response');
    }
  }

  /**
   * Maps the ProtoOAExecutionEvent (the ASYNC response to order requests) into
   * the normalized BrokerOrderResult. Fills use the deal's execution price and
   * timestamp; accepted pending orders report PENDING with the order id.
   * Sprint 50 PR-3: filledQuantity reports the provider's filled volume
   * (deal.filledVolume, falling back to the order's executedVolume).
   */
  private mapExecutionEventToOrderResult(
    response: CtraderMessageEnvelope,
    symbolLotSizeCents: number,
  ): BrokerOrderResult {
    const event = expectCtraderPayload<CtraderExecutionEventPayload>(
      response,
      CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
    );
    const deal = event.deal;
    const position = event.position;
    const protoOrder = event.order;

    switch (event.executionType) {
      case CtraderExecutionType.ORDER_FILLED:
      case CtraderExecutionType.ORDER_PARTIAL_FILL: {
        const externalId = String(
          position?.positionId ?? deal?.positionId ?? protoOrder?.orderId ?? '',
        );
        const filledCents = deal?.filledVolume ?? protoOrder?.executedVolume;
        return {
          success: true,
          externalOrderId: externalId !== '' ? externalId : undefined,
          filledPrice:
            deal?.executionPrice !== undefined
              ? wirePriceToDecimalString(deal.executionPrice)
              : protoOrder?.executionPrice !== undefined
                ? wirePriceToDecimalString(protoOrder.executionPrice)
                : undefined,
          filledQuantity:
            filledCents !== undefined && filledCents > 0
              ? volumeCentsToLotString(filledCents, symbolLotSizeCents)
              : undefined,
          filledAt:
            deal?.executionTimestamp !== undefined
              ? new Date(deal.executionTimestamp)
              : protoOrder?.tradeData?.openTimestamp !== undefined
                ? new Date(protoOrder.tradeData.openTimestamp)
                : new Date(),
          status: 'FILLED',
          brokerMessage:
            event.executionType === CtraderExecutionType.ORDER_PARTIAL_FILL
              ? 'Order partially filled'
              : 'Order filled',
          rawResponse: response.payload,
        };
      }
      case CtraderExecutionType.ORDER_ACCEPTED:
        return {
          success: true,
          externalOrderId:
            protoOrder?.orderId !== undefined ? String(protoOrder.orderId) : undefined,
          status: 'PENDING',
          brokerMessage: 'Order accepted (working)',
          rawResponse: response.payload,
        };
      case CtraderExecutionType.ORDER_REJECTED:
        return {
          success: false,
          externalOrderId:
            protoOrder?.orderId !== undefined ? String(protoOrder.orderId) : undefined,
          status: 'REJECTED',
          brokerMessage: event.errorCode ?? 'Order rejected',
          rawResponse: response.payload,
        };
      case CtraderExecutionType.ORDER_CANCELLED:
      case CtraderExecutionType.ORDER_EXPIRED:
      case CtraderExecutionType.ORDER_CANCEL_REJECTED:
      case CtraderExecutionType.ORDER_REPLACED:
        // Abnormal as the DIRECT response to a new-order request — reported
        // honestly as FAILED instead of pretending success.
        return {
          success: false,
          externalOrderId:
            protoOrder?.orderId !== undefined ? String(protoOrder.orderId) : undefined,
          status: 'FAILED',
          brokerMessage: `Unexpected executionType ${event.executionType} for a new order`,
          rawResponse: response.payload,
        };
      default:
        // SWAP / DEPOSIT_WITHDRAW / BONUS_* are account events, never a
        // new-order response — fail closed with a typed protocol error.
        throw new BrokerAdapterError(
          BrokerErrorCode.BROKER_SERVER_ERROR,
          `cTrader returned account event ${event.executionType} in answer to an order request.`,
        );
    }
  }

  /**
   * Error normalization: BrokerAdapterError passes through; anything else is
   * redacted and typed UNKNOWN (never raw provider text, never credentials).
   *
   * WRITE-CERTAINTY (Sprint 56 correction round 4, architect findings 5-6):
   * errors already classified by the transport/client layer (frame-level
   * accounting) keep their precise classification; adapter-level errors get
   * the code-based default (pre-send validation → DEFINITELY_NOT_SENT;
   * provider-answered rejections → SENT_RESPONSE_RECEIVED). An UNCLASSIFIED
   * raw error is conservatively MAY_HAVE_REACHED_PROVIDER — the orchestrator
   * reconciles instead of resending.
   */
  private mapError(err: unknown): BrokerAdapterError {
    if (err instanceof BrokerAdapterError) {
      return withDefaultCertainty(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    const sanitized = redactString(message);
    this.logger.warn(`cTrader adapter call failed: ${sanitized}`);
    return new BrokerAdapterError(
      BrokerErrorCode.UNKNOWN,
      sanitized,
      sanitized,
      false,
      ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
    );
  }
}
