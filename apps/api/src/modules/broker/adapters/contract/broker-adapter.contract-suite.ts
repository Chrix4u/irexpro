import { Logger } from '@nestjs/common';
import {
  BrokerAdapterError,
  BrokerErrorCode,
  RETRYABLE_BROKER_ERRORS,
} from '../../interfaces/broker-adapter.errors';
import {
  BrokerMode,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
} from '../../interfaces/broker-adapter.interface';

/**
 * Broker adapter contract test suite (Sprint 51 PR-7 — Directive §AN).
 *
 * A provider's spec file calls `runBrokerAdapterContractSuite(name, ctx)` to
 * generate a standard `describe` block that ANY adapter must pass:
 *
 *  1. Fail-closed preconditions — data operations throw NOT_CONNECTED before
 *     `connect()` (never fabricate data on a dead session).
 *  2. Decimal-string invariants — money/quantity fields are decimal strings,
 *     never numbers/NaN.
 *  3. Error normalization — backend failures surface as BrokerAdapterError
 *     with a mapped code and `isRetryable` consistent with
 *     RETRYABLE_BROKER_ERRORS.
 *  4. Environment separation — a DEMO adapter only ever addresses the DEMO
 *     base URL, a LIVE adapter only the LIVE URL (never crossed).
 *  5. Secret redaction — the credential token never leaks into thrown
 *     messages, brokerMessage, Logger output, or result objects.
 *  6. Idempotency passthrough — `placeOrder` transports the idempotencyKey
 *     to the provider payload.
 *  7. No fabricated data — order reads THROW when the backend is failing;
 *     null is only permitted for a legitimate provider "not found".
 *
 * The adapter under test MUST accept an injectable transport (see the
 * OANDA v20 adapter's `OandaTransport` interface): the scripted backend is
 * injected through the context's `createAdapter` factory so the suite can
 * script responses/failures and inspect recorded requests.
 */

// ─── Scripted backend contract ────────────────────────────────────────────────

/** One recorded scripted transport request. */
export interface ScriptedRequestRecord {
  method: string;
  /** Environment base URL the adapter addressed for this request. */
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Pluggable fake HTTP/transport layer injected into the adapter under test.
 * Mirrors the OANDA v20 adapter's injectable `OandaTransport` shape so a
 * scripted backend can be passed directly to transport-backed adapters.
 */
export interface ScriptedBackend {
  request<T>(
    method: string,
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T>;
  /** Requests recorded so far, in call order. */
  readonly requests: ScriptedRequestRecord[];
  /** Force every subsequent request to reject with a raw transport error. */
  failWith(error: unknown): void;
  /** Clear the forced failure mode. */
  restore(): void;
  /** Drop recorded requests (scripting is preserved). */
  resetRequests(): void;
}

/** One scripted route: last-registered match wins (later scripts override). */
export interface ScriptedRoute {
  method: string;
  /** Substring (or RegExp) matched against the request path incl. query. */
  path: string | RegExp;
  /** Return the response payload, or throw to simulate a transport failure. */
  respond: (request: ScriptedRequestRecord) => unknown;
}

/**
 * Ready-to-use generic scripted HTTP backend. Routes are matched against
 * recorded requests in REVERSE registration order (newest script wins).
 */
export class ScriptedHttpBackend implements ScriptedBackend {
  readonly requests: ScriptedRequestRecord[] = [];
  private readonly routes: ScriptedRoute[] = [];
  private failure: unknown;

  route(
    method: string,
    path: string | RegExp,
    respond: (req: ScriptedRequestRecord) => unknown,
  ): this {
    this.routes.push({ method, path, respond });
    return this;
  }

  clearRoutes(): this {
    this.routes.length = 0;
    return this;
  }

  failWith(error: unknown): void {
    this.failure = error;
  }

  restore(): void {
    this.failure = undefined;
  }

  resetRequests(): void {
    this.requests.length = 0;
  }

  async request<T>(
    method: string,
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    this.requests.push({ method, baseUrl, path, headers, body });
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const candidate = this.routes[i];
      if (candidate.method !== method) continue;
      const matches =
        typeof candidate.path === 'string'
          ? path.includes(candidate.path)
          : candidate.path.test(path);
      if (matches) {
        return Promise.resolve(candidate.respond({ method, baseUrl, path, headers, body }) as T);
      }
    }
    return Promise.reject(
      new Error(`contract suite: no scripted route for ${method} ${baseUrl}${path}`),
    );
  }
}

// ─── Suite context contract ───────────────────────────────────────────────────

export interface ContractSuiteOptions {
  /**
   * Skip the environment-routing assertion (in-memory adapters such as the
   * paper broker have no transport-level base URL by construction).
   */
  skipEnvironmentRouting?: boolean;
  /**
   * Skip transport-failure injection (in-memory adapters whose provider
   * state cannot fail — e.g. the PAPER_ONLY paper broker). Skipped tests
   * are still REGISTERED (via `it.skip`) so the gap is visible in output.
   */
  skipTransportFailureInjection?: boolean;
}

export interface ContractSuiteContext {
  /** Catalog id the adapter registers under. */
  brokerId: string;
  supportsDemo: boolean;
  /** Build a FRESH adapter in the given mode with the scripted backend injected. */
  createAdapter(mode: BrokerMode): IBrokerAdapter;
  /**
   * Credentials used for connect(). MUST contain a realistic fake secret in
   * `apiKey` so the suite can verify it never leaks (Directive §AN #5).
   */
  credentials: DecryptedBrokerCredentials;
  /** Injected scripted backend (also inspectable via recorded requests). */
  scriptedBackend: ScriptedBackend;
  /**
   * Leave the scripted backend in a fully healthy, deterministic state for
   * every operation the suite drives (account, instruments, pricing, orders,
   * trades). Implementations should clear and re-script their routes.
   */
  scriptHealthyBackend(): void;
  /**
   * Optional: make provider order lookups answer a legitimate 404-style
   * "not found" (Directive §AN #7 — null is ONLY allowed for genuine
   * not-found responses, never as an error fallback).
   */
  scriptOrderNotFound?(): void;
  /**
   * Read back the idempotency key the provider side observed for the order
   * the suite just placed (OANDA: clientExtensions.id in the POST payload;
   * paper: the resting order's client id). Null when nothing was observed.
   */
  observedIdempotencyKey(): Promise<string | null>;
  /** An instrument symbol the healthy backend prices. */
  pricedInstrument: string;
  /** Expected DEMO environment base URL (required unless routing is skipped). */
  expectedDemoBaseUrl?: string;
  /** Expected LIVE environment base URL (required unless routing is skipped). */
  expectedLiveBaseUrl?: string;
  options?: ContractSuiteOptions;
}

// ─── Directive §AN assertion titles ───────────────────────────────────────────

export const CONTRACT_ASSERTION_TITLES = [
  '§AN-1 fail-closed: data operations throw NOT_CONNECTED before connect()',
  '§AN-2 decimal-string invariants: money/quantity fields are decimal strings',
  '§AN-3 error normalization: backend failures map to BrokerAdapterError with consistent isRetryable',
  '§AN-4 environment separation: DEMO never addresses the LIVE base URL and vice versa',
  '§AN-5 secret redaction: the credential token never leaks into errors, messages, logs, or results',
  '§AN-6 idempotency passthrough: placeOrder transports the idempotencyKey to the provider',
  '§AN-7a no fabricated data: order reads THROW when the backend is failing',
  '§AN-7b no fabricated data: getOrderById returns null ONLY for a legitimate not-found',
] as const;

// ─── Shared helpers (exported for direct harness testing) ─────────────────────

const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

/** True only for strings that are exact decimal numerics (no exponent/NaN). */
export function isDecimalString(value: unknown): boolean {
  return typeof value === 'string' && DECIMAL_STRING_PATTERN.test(value);
}

/** Normalized-surface keys that MUST carry decimal-string values. */
const MONEY_KEYS = new Set<string>([
  'balance',
  'equity',
  'margin',
  'freeMargin',
  'marginLevel',
  'bid',
  'ask',
  'spread',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'lotSize',
  'minLot',
  'maxLot',
  'lotStep',
  'contractSize',
  'openPrice',
  'closePrice',
  'currentPrice',
  'stopLoss',
  'takeProfit',
  'unrealisedPnl',
  'realisedPnl',
  'commission',
  'swap',
  'filledPrice',
  'filledQuantity',
  'requestedQuantity',
]);

/**
 * Walk a normalized adapter result and collect every money/quantity value.
 * `rawResponse` subtrees are skipped: provider raw payloads are not the
 * normalized surface (they are provider-formatted, not contract-formatted).
 */
export function collectMoneyValues(value: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectMoneyValues(entry, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'rawResponse') continue;
      if (MONEY_KEYS.has(key)) {
        out.push(child);
      } else {
        collectMoneyValues(child, out, depth + 1);
      }
    }
  }
  return out;
}

function stringifyForScan(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Spy on every Nest Logger level and collect the emitted output lines. */
function captureLoggerOutput(): { lines(): string[]; restore(): void } {
  const levels = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
  const lines: string[] = [];
  const spies = levels.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => stringifyForScan(arg)).join(' '));
    }),
  );
  return {
    lines: () => lines.slice(),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

async function expectNotConnected(operation: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await operation();
  } catch (err) {
    expect(err).toBeInstanceOf(BrokerAdapterError);
    const typed = err as BrokerAdapterError;
    expect(typed.code).toBe(BrokerErrorCode.NOT_CONNECTED);
    return;
  }
  throw new Error(`contract suite: ${label} must throw NOT_CONNECTED before connect()`);
}

async function expectMappedBrokerAdapterError(
  operation: () => Promise<unknown>,
  label: string,
): Promise<BrokerAdapterError> {
  try {
    await operation();
  } catch (err) {
    expect(err).toBeInstanceOf(BrokerAdapterError);
    return err as BrokerAdapterError;
  }
  throw new Error(`contract suite: ${label} must throw a BrokerAdapterError (never a raw error)`);
}

function marketOrder(
  ctx: ContractSuiteContext,
  tag: string,
): Parameters<IBrokerAdapter['placeOrder']>[0] {
  return {
    idempotencyKey: `contract-${tag}-idempotency-key`,
    instrument: ctx.pricedInstrument,
    direction: 'BUY',
    lotSize: '0.01',
    stopLoss: '1.09000',
    takeProfit: '1.11000',
    orderKind: 'MARKET',
    timeInForce: 'GTC',
  };
}

/** Reset backend scripting + records, then re-script the healthy state. */
function prepareHealthyBackend(ctx: ContractSuiteContext): void {
  ctx.scriptedBackend.restore();
  ctx.scriptedBackend.resetRequests();
  ctx.scriptHealthyBackend();
}

// ─── The suite generator ──────────────────────────────────────────────────────

/**
 * Generate the standard Directive §AN contract `describe` block for one
 * adapter. Call at spec-file describe scope. Returns the titles of the
 * registered assertions (skipped assertions are registered via `it.skip`
 * so they remain visible in the test output).
 */
export function runBrokerAdapterContractSuite(name: string, ctx: ContractSuiteContext): string[] {
  const skipRouting = ctx.options?.skipEnvironmentRouting === true;
  const skipFailureInjection = ctx.options?.skipTransportFailureInjection === true;
  const registered: string[] = [];

  describe(`${name} — broker adapter contract suite (Directive §AN)`, () => {
    afterAll(() => {
      ctx.scriptedBackend.restore();
    });

    // §AN-1 — fail-closed preconditions before connect()
    registered.push(CONTRACT_ASSERTION_TITLES[0]);
    it(CONTRACT_ASSERTION_TITLES[0], async () => {
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await expectNotConnected(() => adapter.getAccountInfo(), 'getAccountInfo()');
      await expectNotConnected(() => adapter.getAccountBalance(), 'getAccountBalance()');
      await expectNotConnected(() => adapter.getOpenPositions(), 'getOpenPositions()');
      await expectNotConnected(() => adapter.listOrders(), 'listOrders()');
      await expectNotConnected(
        () => adapter.getCurrentPrice(ctx.pricedInstrument),
        'getCurrentPrice()',
      );
      await expectNotConnected(() => adapter.placeOrder(marketOrder(ctx, 'an1')), 'placeOrder()');
    });

    // §AN-2 — decimal-string invariants on the normalized surface
    registered.push(CONTRACT_ASSERTION_TITLES[1]);
    it(CONTRACT_ASSERTION_TITLES[1], async () => {
      prepareHealthyBackend(ctx);
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await adapter.connect(ctx.credentials);
      const results: unknown[] = [];
      results.push(await adapter.placeOrder(marketOrder(ctx, 'an2')));
      results.push(await adapter.getAccountInfo());
      results.push(await adapter.getAccountBalance());
      results.push(await adapter.getCurrentPrice(ctx.pricedInstrument));
      results.push(await adapter.getOpenPositions());
      const collected = results.flatMap((result) => collectMoneyValues(result));
      expect(collected.length).toBeGreaterThan(0);
      for (const value of collected) {
        expect(typeof value).toBe('string');
        expect(isDecimalString(value)).toBe(true);
      }
    });

    // §AN-3 — error normalization with consistent retryability
    registered.push(CONTRACT_ASSERTION_TITLES[2]);
    (skipFailureInjection ? it.skip : it)(CONTRACT_ASSERTION_TITLES[2], async () => {
      prepareHealthyBackend(ctx);
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await adapter.connect(ctx.credentials);
      ctx.scriptedBackend.failWith(new Error('contract suite: simulated transport outage'));
      const err = await expectMappedBrokerAdapterError(
        () => adapter.getAccountInfo(),
        'getAccountInfo() under backend failure',
      );
      expect(Object.values(BrokerErrorCode)).toContain(err.code);
      expect(err.isRetryable).toBe(RETRYABLE_BROKER_ERRORS.has(err.code));
    });

    // §AN-4 — environment separation (DEMO vs LIVE base URLs never cross)
    registered.push(CONTRACT_ASSERTION_TITLES[3]);
    (skipRouting ? it.skip : it)(CONTRACT_ASSERTION_TITLES[3], async () => {
      expect(ctx.expectedDemoBaseUrl).toBeDefined();
      expect(ctx.expectedLiveBaseUrl).toBeDefined();
      const demoBase = ctx.expectedDemoBaseUrl as string;
      const liveBase = ctx.expectedLiveBaseUrl as string;
      expect(liveBase).not.toBe(demoBase);

      prepareHealthyBackend(ctx);
      const demoAdapter = ctx.createAdapter(BrokerMode.DEMO);
      await demoAdapter.connect(ctx.credentials);
      await demoAdapter.getAccountInfo();
      expect(ctx.scriptedBackend.requests.length).toBeGreaterThan(0);
      for (const request of ctx.scriptedBackend.requests) {
        expect(request.baseUrl).toBe(demoBase);
        expect(request.baseUrl).not.toBe(liveBase);
      }

      prepareHealthyBackend(ctx);
      const liveAdapter = ctx.createAdapter(BrokerMode.LIVE);
      await liveAdapter.connect(ctx.credentials);
      await liveAdapter.getAccountInfo();
      expect(ctx.scriptedBackend.requests.length).toBeGreaterThan(0);
      for (const request of ctx.scriptedBackend.requests) {
        expect(request.baseUrl).toBe(liveBase);
        expect(request.baseUrl).not.toBe(demoBase);
      }
    });

    // §AN-5 — secret redaction across errors, brokerMessage, logs, and results
    registered.push(CONTRACT_ASSERTION_TITLES[4]);
    it(CONTRACT_ASSERTION_TITLES[4], async () => {
      const secret = ctx.credentials.apiKey ?? '';
      expect(secret.length).toBeGreaterThan(8);
      const logger = captureLoggerOutput();
      try {
        // Healthy pass — results and logs must not carry the token.
        prepareHealthyBackend(ctx);
        const adapter = ctx.createAdapter(BrokerMode.DEMO);
        const connection = await adapter.connect(ctx.credentials);
        const account = await adapter.getAccountInfo();
        const fill = await adapter.placeOrder(marketOrder(ctx, 'an5'));
        const scanTargets = [
          stringifyForScan(connection),
          stringifyForScan(account),
          stringifyForScan(fill),
        ];

        // Failing pass — the raw transport error EMBEDS the secret; the
        // adapter must surface a redacted, normalized error.
        ctx.scriptedBackend.failWith(
          new Error(`contract suite: transport failure for token=${secret}`),
        );
        let failure: unknown = null;
        try {
          await adapter.getAccountInfo();
        } catch (err) {
          failure = err;
        }
        if (failure !== null) {
          expect(failure).toBeInstanceOf(BrokerAdapterError);
          const typed = failure as BrokerAdapterError;
          scanTargets.push(typed.message);
          scanTargets.push(typed.brokerMessage ?? '');
        }
        ctx.scriptedBackend.restore();

        for (const line of logger.lines()) scanTargets.push(line);
        for (const target of scanTargets) {
          expect(target.includes(secret)).toBe(false);
        }
      } finally {
        logger.restore();
      }
    });

    // §AN-6 — idempotency passthrough (resting order so both transport-backed
    // and in-memory adapters surface the key on their provider-side record)
    registered.push(CONTRACT_ASSERTION_TITLES[5]);
    it(CONTRACT_ASSERTION_TITLES[5], async () => {
      prepareHealthyBackend(ctx);
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await adapter.connect(ctx.credentials);
      const key = 'contract-an6-idempotency-passthrough-key';
      await adapter.placeOrder({
        idempotencyKey: key,
        instrument: ctx.pricedInstrument,
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '1.09000',
        takeProfit: '1.11000',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
        timeInForce: 'GTC',
      });
      expect(await ctx.observedIdempotencyKey()).toBe(key);
    });

    // §AN-7a — no fabricated data: THROW on backend failure (never [] / null)
    registered.push(CONTRACT_ASSERTION_TITLES[6]);
    (skipFailureInjection ? it.skip : it)(CONTRACT_ASSERTION_TITLES[6], async () => {
      prepareHealthyBackend(ctx);
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await adapter.connect(ctx.credentials);
      ctx.scriptedBackend.failWith(new Error('contract suite: backend down'));
      await expectMappedBrokerAdapterError(
        () => adapter.listOrders(),
        'listOrders() under backend failure',
      );
      await expectMappedBrokerAdapterError(
        () => adapter.getOrderById('contract-an7-any-order'),
        'getOrderById() under backend failure',
      );
    });

    // §AN-7b — null ONLY for a legitimate provider not-found
    registered.push(CONTRACT_ASSERTION_TITLES[7]);
    it(CONTRACT_ASSERTION_TITLES[7], async () => {
      prepareHealthyBackend(ctx);
      const adapter = ctx.createAdapter(BrokerMode.DEMO);
      await adapter.connect(ctx.credentials);
      ctx.scriptOrderNotFound?.();
      const order = await adapter.getOrderById('contract-nonexistent-order');
      expect(order).toBeNull();
    });
  });

  return registered;
}
