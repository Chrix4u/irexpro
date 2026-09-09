/**
 * CTraderClientService — cTrader Open API connection manager (Sprint 56 /
 * Task 47-C2). Mirrors the MetaApiClientService pattern: a platform-level
 * provider service owning all provider connections, with the adapter staying
 * a thin mapping layer.
 *
 * PROTOCOL IMPLEMENTATION (verified facts — worklog 47-B1 + official .proto):
 * - At most ONE WebSocket per environment (demo + live = max 2 connections,
 *   the recommended platform limit). One connection can hold many accounts.
 * - Handshake ORDER is mandatory: ProtoOAApplicationAuthReq (2100) with the
 *   platform app credentials FIRST — anything before it errors — then
 *   per-account ProtoOAAccountAuthReq (2102) with the user's OAuth access
 *   token.
 * - Requests are matched to responses by the ECHOED clientMsgId.
 * - Heartbeat: payloadType 51 at least every 10 s or the server disconnects.
 * - Rate limits: 50 req/s general, 5 req/s historical (token-bucket enforced
 *   client-side; breach fails closed with RATE_LIMITED instead of firing a
 *   request the server would reject with 108/BLOCKED_PAYLOAD_TYPE).
 * - Reconnect: exponential backoff 3 s → 6 s → 12 s → 24 s (capped), max 5
 *   attempts, then app-auth re-handshake + re-auth of every remembered
 *   account session.
 *
 * SECURITY INVARIANTS:
 * - The platform cTrader app credentials (CTRADER_CLIENT_ID/SECRET) live in
 *   env config ONLY — never logged, never in errors.
 * - Per-user OAuth access tokens are held in MEMORY (connection session map)
 *   for the duration of a session — never logged, never persisted.
 * - Inbound frames are parsed defensively; malformed frames are dropped
 *   WITHOUT logging content.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  CTRADER_ENVIRONMENT_URLS,
  CTRADER_HISTORICAL_PAYLOAD_TYPES,
  CTRADER_PAYLOAD_TYPE,
  CtraderDiscoveredAccount,
  CtraderEnvironment,
  CtraderMessageEnvelope,
  isAlreadyAuthorizedError,
  mapCtraderError,
  parseCtraderId,
} from './ctrader-message-types';
import { CtraderTransport, NodeWebSocketCtraderTransport } from './ctrader-transport';
import {
  buildCtraderAuthorizationUrl,
  buildCtraderTokenRequestUrl,
  CtraderOAuthTokens,
  CtraderTokenExchangeRequest,
  parseCtraderTokenResponse,
} from './ctrader-oauth';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

/** Request/response timeout (the platform's responsiveness budget). */
const REQUEST_TIMEOUT_MS = 10_000;
/** Heartbeat interval — the server disconnects at >10 s of silence. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Reconnect backoff schedule (exponential, capped) — max 5 attempts. */
const RECONNECT_DELAYS_MS: readonly number[] = [3_000, 6_000, 12_000, 24_000, 24_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;
/** General rate limit per connection (requests/second). */
const GENERAL_RATE_LIMIT_PER_SECOND = 50;
/** Historical rate limit per connection (requests/second). */
const HISTORICAL_RATE_LIMIT_PER_SECOND = 5;
/**
 * Bounded-transport ceiling: maximum concurrent UNANSWERED requests per
 * connection (Task 47 correction round — audit point 4 "bounded memory /
 * fail fast backpressure"). The rate limiter bounds throughput and the 10 s
 * timeout bounds lifetime, but the pending map itself needs an explicit
 * ceiling so a stalling provider can never accumulate unbounded state —
 * requests beyond the ceiling fail fast with a retryable RATE_LIMITED error
 * (never queued, never slept on, never silently dropped). 500 ≈ the worst
 * legal steady state (50 r/s general + 5 r/s historical × 10 s timeout).
 */
const MAX_IN_FLIGHT_REQUESTS = 500;
export { MAX_IN_FLIGHT_REQUESTS as CTRADER_MAX_IN_FLIGHT_REQUESTS };

/** Client-side token bucket (sliding refill) used per rate-limit class. */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefillMs = now;
    }
  }
}

interface PendingRequest {
  resolve: (message: CtraderMessageEnvelope) => void;
  reject: (error: BrokerAdapterError) => void;
  timer: NodeJS.Timeout;
  requestPayloadType: number;
}

interface EventWaiter {
  predicate: (message: CtraderMessageEnvelope) => boolean;
  resolve: (message: CtraderMessageEnvelope) => void;
  reject: (error: BrokerAdapterError) => void;
  timer: NodeJS.Timeout;
}

/** One environment connection (DEMO or LIVE — never shared between them). */
class EnvironmentConnection {
  readonly generalBucket = new TokenBucket(
    GENERAL_RATE_LIMIT_PER_SECOND,
    GENERAL_RATE_LIMIT_PER_SECOND,
  );
  readonly historicalBucket = new TokenBucket(
    HISTORICAL_RATE_LIMIT_PER_SECOND,
    HISTORICAL_RATE_LIMIT_PER_SECOND,
  );
  transport: CtraderTransport;
  appAuthenticated = false;
  /** Accounts authorized on the CURRENT transport session. */
  readonly authorizedAccounts = new Set<number>();
  /**
   * Account access tokens remembered for re-auth after reconnect.
   * MEMORY-ONLY provider credentials — never logged, never persisted.
   */
  readonly accountTokens = new Map<number, string>();
  readonly pending = new Map<string, PendingRequest>();
  readonly waiters = new Set<EventWaiter>();
  heartbeatTimer: NodeJS.Timeout | null = null;
  reconnectTimer: NodeJS.Timeout | null = null;
  reconnectAttempts = 0;
  closedIntentionally = false;
  establishing: Promise<void> | null = null;

  constructor(
    readonly env: CtraderEnvironment,
    transport: CtraderTransport,
  ) {
    this.transport = transport;
  }
}

@Injectable()
export class CTraderClientService implements OnModuleDestroy {
  private readonly logger = new Logger(CTraderClientService.name);
  private readonly connections = new Map<CtraderEnvironment, EnvironmentConnection>();
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('broker.ctraderClientId', '') ?? '';
    this.clientSecret = this.configService.get<string>('broker.ctraderClientSecret', '') ?? '';
    if (!this.isAvailable()) {
      this.logger.warn(
        'CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET are not set. cTrader connections will fail ' +
          'closed until the platform cTrader Open API application credentials are configured.',
      );
    }
  }

  /** True when the platform cTrader Open API app credentials are configured. */
  isAvailable(): boolean {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Brings an environment connection up (app auth 2100 FIRST) and authorizes
   * the trading account on it (2102). Idempotent — existing sessions are
   * reused, which is what makes DEMO+LIVE coexist as two connections.
   */
  async ensureAccountSession(
    env: CtraderEnvironment,
    ctidTraderAccountId: string,
    accessToken: string,
  ): Promise<void> {
    const conn = await this.ensureEnvConnection(env);
    const accountId = parseCtraderId(ctidTraderAccountId, 'ctidTraderAccountId');
    conn.accountTokens.set(accountId, accessToken);
    if (conn.authorizedAccounts.has(accountId)) {
      return;
    }
    const response = await this.rawRequest(conn, CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: accountId,
      accessToken,
    });
    if (response.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_RES) {
      conn.authorizedAccounts.add(accountId);
      return;
    }
    // ALREADY_LOGGED_IN resolves through rawRequest as a benign envelope.
    if (
      response.payloadType === CTRADER_PAYLOAD_TYPE.OA_ERROR_RES &&
      this.errorName(response) === 'ALREADY_LOGGED_IN'
    ) {
      conn.authorizedAccounts.add(accountId);
      return;
    }
    throw mapCtraderError(
      this.errorName(response),
      `Unexpected account-auth response payloadType ${response.payloadType}`,
    );
  }

  /** Drops an account session; closes the environment connection when idle. */
  async removeAccountSession(env: CtraderEnvironment, ctidTraderAccountId: string): Promise<void> {
    const conn = this.connections.get(env);
    if (!conn) return;
    const accountId = parseCtraderId(ctidTraderAccountId, 'ctidTraderAccountId');
    conn.accountTokens.delete(accountId);
    conn.authorizedAccounts.delete(accountId);
    if (conn.accountTokens.size === 0) {
      this.closeEnvironmentConnection(env);
    }
  }

  /** True when the account is authorized on a live (open + app-authed) connection. */
  hasAccountSession(env: CtraderEnvironment, ctidTraderAccountId: string): boolean {
    const conn = this.connections.get(env);
    if (!conn || !conn.transport.isOpen() || !conn.appAuthenticated) return false;
    let accountId: number;
    try {
      accountId = parseCtraderId(ctidTraderAccountId, 'ctidTraderAccountId');
    } catch {
      return false;
    }
    return conn.authorizedAccounts.has(accountId);
  }

  isEnvConnected(env: CtraderEnvironment): boolean {
    const conn = this.connections.get(env);
    return !!conn && conn.transport.isOpen() && conn.appAuthenticated;
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Sends a request and resolves with the response matched by the ECHOED
   * clientMsgId. Error envelopes (2142 / 50) reject with a typed, redacted
   * BrokerAdapterError. 10 s timeout → CONNECTION_TIMEOUT (retryable).
   */
  async request(
    env: CtraderEnvironment,
    payloadType: number,
    payload: Record<string, unknown>,
  ): Promise<CtraderMessageEnvelope> {
    const conn = await this.ensureEnvConnection(env);
    return this.rawRequest(conn, payloadType, payload);
  }

  /**
   * Registers a waiter for a SERVER-INITIATED event (no clientMsgId echo —
   * e.g. ProtoOASpotEvent 2131). Register BEFORE issuing the request that
   * triggers the event so no early event is missed.
   */
  awaitEvent(
    env: CtraderEnvironment,
    predicate: (message: CtraderMessageEnvelope) => boolean,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<CtraderMessageEnvelope> {
    const conn = this.connections.get(env);
    if (!conn || !conn.transport.isOpen() || !conn.appAuthenticated) {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.NOT_CONNECTED,
          `cTrader ${env} connection is not established.`,
        ),
      );
    }
    return new Promise<CtraderMessageEnvelope>((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          conn.waiters.delete(waiter);
          reject(
            new BrokerAdapterError(
              BrokerErrorCode.CONNECTION_TIMEOUT,
              `Timed out waiting for a cTrader ${env} event.`,
              undefined,
              true,
            ),
          );
        }, timeoutMs),
      };
      conn.waiters.add(waiter);
    });
  }

  // ─── Account discovery + OAuth (token endpoint via native fetch) ───────────

  /**
   * ProtoOAGetAccountListByAccessTokenReq (2149) — discovers every trading
   * account granted to the access token, with isLive (decides the host) and
   * brokerTitleShort (the actual broker behind the cTrader account).
   */
  async discoverAccounts(
    env: CtraderEnvironment,
    accessToken: string,
  ): Promise<CtraderDiscoveredAccount[]> {
    const response = await this.request(
      env,
      CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
      {
        accessToken,
      },
    );
    if (response.payloadType !== CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES) {
      throw mapCtraderError(
        this.errorName(response),
        `Unexpected account-list response payloadType ${response.payloadType}`,
      );
    }
    const rawAccounts = Array.isArray(response.payload?.ctidTraderAccount)
      ? (response.payload.ctidTraderAccount as unknown[])
      : [];
    return rawAccounts.map((raw) => {
      const account = (raw ?? {}) as Record<string, unknown>;
      return {
        ctidTraderAccountId: parseCtraderId(account.ctidTraderAccountId, 'ctidTraderAccountId'),
        isLive: account.isLive === true,
        traderLogin:
          account.traderLogin !== undefined && account.traderLogin !== null
            ? parseCtraderId(account.traderLogin, 'traderLogin')
            : undefined,
        brokerTitleShort:
          typeof account.brokerTitleShort === 'string' ? account.brokerTitleShort : undefined,
      };
    });
  }

  /**
   * Refreshes the OAuth access token with a (non-expiring) refresh token.
   * Used by the verification harness and by credentials carrying a
   * refreshToken — never logged, never persisted.
   */
  async refreshAccessToken(refreshToken: string): Promise<CtraderOAuthTokens> {
    if (!this.isAvailable()) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'cTrader Open API application credentials are not configured. ' +
          'Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET (the platform cTrader app).',
      );
    }
    return this.exchangeToken({
      grantType: 'refresh_token',
      refreshToken,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  /** Exchanges an authorization code (or refresh token) at the OAuth token endpoint. */
  async exchangeToken(request: CtraderTokenExchangeRequest): Promise<CtraderOAuthTokens> {
    const url = buildCtraderTokenRequestUrl(request);
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_TIMEOUT,
        'cTrader token endpoint is unreachable.',
        undefined,
        true,
      );
    }
    if (!response.ok) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        `cTrader token endpoint returned HTTP ${response.status}.`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'cTrader token endpoint returned a non-JSON body.',
      );
    }
    return parseCtraderTokenResponse(body);
  }

  /**
   * Builds the user-consent URL for the PLATFORM application (Sprint 56
   * correction round — audit point 6). The client id is a PUBLIC OAuth
   * identifier (it appears in the consent URL every user sees); the client
   * SECRET never leaves this class.
   */
  buildAuthorizationUrl(
    redirectUri: string,
    scope: 'trading' | 'accounts' = 'trading',
  ): string {
    return buildCtraderAuthorizationUrl(this.clientId, redirectUri, scope);
  }

  /**
   * Exchanges a USER authorization code using the PLATFORM application
   * credentials (authorization-code grant). User-supplied broker credentials
   * are NEVER application credentials — the platform's own id/secret pair
   * rides this exchange (audit point 1/6 boundary).
   */
  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<CtraderOAuthTokens> {
    if (!this.isAvailable()) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'cTrader Open API application credentials are not configured. ' +
          'Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET (the platform cTrader app).',
      );
    }
    return this.exchangeToken({
      grantType: 'authorization_code',
      code,
      redirectUri,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    for (const env of Array.from(this.connections.keys())) {
      this.closeEnvironmentConnection(env);
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Production transport factory — tests shadow this with fakes. */
  protected createTransport(): CtraderTransport {
    return new NodeWebSocketCtraderTransport();
  }

  /**
   * Injectable in-flight ceiling (determinism seam for the audit-point-4
   * tests — production always uses MAX_IN_FLIGHT_REQUESTS).
   */
  protected maxInFlightRequests: number = MAX_IN_FLIGHT_REQUESTS;

  /**
   * Returns the environment connection, establishing it (transport connect +
   * 2100 app auth, heartbeat) when needed. Concurrent callers share ONE
   * in-flight establish promise.
   */
  private async ensureEnvConnection(env: CtraderEnvironment): Promise<EnvironmentConnection> {
    const existing = this.connections.get(env);
    if (existing && existing.transport.isOpen() && existing.appAuthenticated) {
      return existing;
    }
    if (existing?.establishing) {
      await existing.establishing;
      if (existing.transport.isOpen() && existing.appAuthenticated) {
        return existing;
      }
      throw new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_LOST,
        `cTrader ${env} connection could not be established.`,
        undefined,
        true,
      );
    }
    const transport = this.createTransport();
    const conn = existing ?? new EnvironmentConnection(env, transport);
    if (!existing) {
      this.connections.set(env, conn);
    }
    this.attachTransport(conn, transport);
    conn.establishing = this.authenticateApplication(conn);
    try {
      await conn.establishing;
    } finally {
      conn.establishing = null;
    }
    return conn;
  }

  private attachTransport(conn: EnvironmentConnection, transport: CtraderTransport): void {
    conn.transport = transport;
    transport.onMessage((raw) => this.handleInbound(conn, raw));
    transport.onClose((code) => this.handleTransportClosed(conn, code));
  }

  /** App auth 2100 — the FIRST message on any fresh connection. */
  private async authenticateApplication(conn: EnvironmentConnection): Promise<void> {
    // Configuration gate BEFORE any network activity: an unconfigured platform
    // app never opens a socket — the failure is fail-closed and immediate.
    if (!this.isAvailable()) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'cTrader Open API application credentials are not configured. ' +
          'Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET (the platform cTrader app) ' +
          'to enable cTrader connections.',
      );
    }
    const url = CTRADER_ENVIRONMENT_URLS[conn.env];
    await conn.transport.connect(url);
    const response = await this.rawRequest(
      conn,
      CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ,
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      },
      { skipAuthCheck: true },
    );
    if (response.payloadType !== CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_RES) {
      throw mapCtraderError(
        this.errorName(response),
        `Unexpected application-auth response payloadType ${response.payloadType}`,
      );
    }
    conn.appAuthenticated = true;
    conn.reconnectAttempts = 0;
    this.startHeartbeat(conn);
    this.logger.log(`cTrader ${conn.env} connection established (application authenticated)`);
  }

  private startHeartbeat(conn: EnvironmentConnection): void {
    this.stopHeartbeat(conn);
    conn.heartbeatTimer = setInterval(() => {
      // Heartbeat is an event, not a request: it bypasses the rate limiter.
      conn.transport.send({
        payloadType: CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT,
        payload: {},
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(conn: EnvironmentConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
  }

  /**
   * Low-level request: rate-limits, registers the pending entry, sends, and
   * resolves on the clientMsgId echo. Must be called on a transport that is
   * already connected (app auth flow passes skipAuthCheck for 2100 itself).
   */
  private rawRequest(
    conn: EnvironmentConnection,
    payloadType: number,
    payload: Record<string, unknown>,
    options: { skipAuthCheck?: boolean } = {},
  ): Promise<CtraderMessageEnvelope> {
    // A request racing a connection loss must surface CONNECTION_LOST (the
    // truthful condition), never a misleading auth error.
    if (!conn.transport.isOpen()) {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.CONNECTION_LOST,
          `cTrader ${conn.env} connection is not open.`,
          undefined,
          true,
        ),
      );
    }
    if (!options.skipAuthCheck && !conn.appAuthenticated) {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.AUTHENTICATION_FAILED,
          'cTrader application auth (ProtoOAApplicationAuthReq) must complete before any ' +
            'other request — the server rejects anything sent before it.',
        ),
      );
    }
    if (!payloadType || typeof payloadType !== 'number') {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.BROKER_SERVER_ERROR,
          'Refusing to send a cTrader request without a numeric payloadType.',
        ),
      );
    }
    const bucket = CTRADER_HISTORICAL_PAYLOAD_TYPES.has(payloadType)
      ? conn.historicalBucket
      : conn.generalBucket;
    if (!bucket.tryAcquire()) {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.RATE_LIMITED,
          `cTrader rate limit reached for payloadType ${payloadType} — retry shortly.`,
          undefined,
          true,
        ),
      );
    }
    // Bounded transport (audit point 4): explicit in-flight ceiling — the
    // pending map can never grow past maxInFlightRequests. Beyond the
    // ceiling the caller fails FAST (retryable) instead of queueing.
    if (conn.pending.size >= this.maxInFlightRequests) {
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.RATE_LIMITED,
          `cTrader ${conn.env} connection is at its in-flight request ceiling ` +
            `(${this.maxInFlightRequests}) — retry when outstanding requests settle.`,
          undefined,
          true,
        ),
      );
    }
    const clientMsgId = randomUUID();
    return new Promise<CtraderMessageEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(clientMsgId);
        reject(
          new BrokerAdapterError(
            BrokerErrorCode.CONNECTION_TIMEOUT,
            `cTrader request (payloadType ${payloadType}) timed out after ${REQUEST_TIMEOUT_MS}ms.`,
            undefined,
            true,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      conn.pending.set(clientMsgId, { resolve, reject, timer, requestPayloadType: payloadType });
      conn.transport.send({ clientMsgId, payloadType, payload });
    });
  }

  /** Inbound message pump: echo matching first, then event waiters. */
  private handleInbound(conn: EnvironmentConnection, raw: unknown): void {
    const envelope = this.normalizeEnvelope(raw);
    if (!envelope) {
      return; // malformed frame — dropped without logging content
    }
    if (envelope.clientMsgId && conn.pending.has(envelope.clientMsgId)) {
      const pending = conn.pending.get(envelope.clientMsgId)!;
      conn.pending.delete(envelope.clientMsgId);
      clearTimeout(pending.timer);
      if (
        envelope.payloadType === CTRADER_PAYLOAD_TYPE.OA_ERROR_RES ||
        envelope.payloadType === CTRADER_PAYLOAD_TYPE.PROTO_ERROR_RES
      ) {
        const name = this.errorName(envelope);
        // ALREADY_LOGGED_IN on an account-auth request is benign (the account
        // is already authorized on this connection) — resolve, do not reject.
        if (
          pending.requestPayloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ &&
          isAlreadyAuthorizedError(name)
        ) {
          pending.resolve(envelope);
          return;
        }
        pending.reject(
          mapCtraderError(
            name,
            typeof envelope.payload?.description === 'string'
              ? envelope.payload.description
              : undefined,
          ),
        );
        return;
      }
      pending.resolve(envelope);
      return;
    }
    // Server-initiated event: offer to waiters (spot events, executions…).
    for (const waiter of Array.from(conn.waiters)) {
      if (waiter.predicate(envelope)) {
        conn.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(envelope);
      }
    }
  }

  private handleTransportClosed(conn: EnvironmentConnection, code: number | undefined): void {
    if (conn.closedIntentionally) {
      return;
    }
    conn.appAuthenticated = false;
    conn.authorizedAccounts.clear();
    this.stopHeartbeat(conn);
    this.failAllPending(conn, `cTrader ${conn.env} connection lost (code ${code ?? 'n/a'}).`);
    this.logger.warn(`cTrader ${conn.env} connection lost (code ${code ?? 'n/a'}) — reconnecting`);
    this.scheduleReconnect(conn);
  }

  private scheduleReconnect(conn: EnvironmentConnection): void {
    if (conn.reconnectTimer) {
      return;
    }
    if (conn.closedIntentionally) {
      return;
    }
    if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `cTrader ${conn.env} reconnect attempts exhausted (${MAX_RECONNECT_ATTEMPTS}) — connection closed`,
      );
      return;
    }
    const delayMs = RECONNECT_DELAYS_MS[conn.reconnectAttempts];
    conn.reconnectAttempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      void this.reconnect(conn).catch(() => {
        /* handled inside reconnect (schedules the next attempt) */
      });
    }, delayMs);
  }

  private async reconnect(conn: EnvironmentConnection): Promise<void> {
    try {
      this.attachTransport(conn, this.createTransport());
      await this.authenticateApplication(conn);
      // Re-auth every remembered account session on the fresh transport.
      for (const [accountId, accessToken] of Array.from(conn.accountTokens.entries())) {
        try {
          const response = await this.rawRequest(conn, CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ, {
            ctidTraderAccountId: accountId,
            accessToken,
          });
          if (
            response.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_RES ||
            this.errorName(response) === 'ALREADY_LOGGED_IN'
          ) {
            conn.authorizedAccounts.add(accountId);
          }
        } catch (err) {
          // Account session lost — surfaced on next use; never log the token.
          this.logger.warn(
            `cTrader ${conn.env} account session re-auth failed after reconnect: ` +
              `${err instanceof BrokerAdapterError ? err.code : 'UNKNOWN'}`,
          );
        }
      }
      this.logger.log(`cTrader ${conn.env} connection re-established after reconnect`);
    } catch {
      this.scheduleReconnect(conn);
    }
  }

  private failAllPending(conn: EnvironmentConnection, message: string): void {
    for (const [id, pending] of Array.from(conn.pending.entries())) {
      clearTimeout(pending.timer);
      conn.pending.delete(id);
      pending.reject(
        new BrokerAdapterError(BrokerErrorCode.CONNECTION_LOST, message, undefined, true),
      );
    }
    for (const waiter of Array.from(conn.waiters)) {
      clearTimeout(waiter.timer);
      conn.waiters.delete(waiter);
      waiter.reject(
        new BrokerAdapterError(BrokerErrorCode.CONNECTION_LOST, message, undefined, true),
      );
    }
  }

  private closeEnvironmentConnection(env: CtraderEnvironment): void {
    const conn = this.connections.get(env);
    if (!conn) return;
    conn.closedIntentionally = true;
    this.stopHeartbeat(conn);
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.failAllPending(conn, `cTrader ${env} connection closed.`);
    try {
      conn.transport.close();
    } catch {
      /* best-effort */
    }
    this.connections.delete(env);
    this.logger.log(`cTrader ${env} connection closed`);
  }

  private normalizeEnvelope(raw: unknown): CtraderMessageEnvelope | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.payloadType !== 'number' || !Number.isFinite(record.payloadType)) {
      return null;
    }
    if (
      record.payload !== undefined &&
      (record.payload === null || typeof record.payload !== 'object')
    ) {
      return null;
    }
    const clientMsgId =
      typeof record.clientMsgId === 'string' && record.clientMsgId !== ''
        ? record.clientMsgId
        : undefined;
    return {
      clientMsgId,
      payloadType: record.payloadType,
      payload: (record.payload as Record<string, unknown> | undefined | null) ?? undefined,
    };
  }

  private errorName(envelope: CtraderMessageEnvelope): string | undefined {
    const code = envelope.payload?.errorCode;
    return typeof code === 'string' ? code.toUpperCase() : undefined;
  }
}
