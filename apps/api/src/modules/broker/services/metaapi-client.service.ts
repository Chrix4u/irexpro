import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import MetaApi from 'metaapi.cloud-sdk';

/**
 * RPC connection entry in the pool.
 */
export interface MetaApiConnectionEntry {
  account: ReturnType<
    InstanceType<typeof MetaApi>['metatraderAccountApi']['getAccount']
  > extends Promise<infer T>
    ? T
    : never;
  connection: any;
  connectedAt: Date;
  accountId: string;
}

/**
 * MetaApiClientService — Manages the MetaAPI SDK lifecycle and per-account connection pool.
 *
 * Architecture:
 * - One MetaApi SDK instance per platform (keyed by METAAPI_TOKEN)
 * - One RPC connection per MetaAPI accountId, pooled and reused
 * - Connections are created lazily on first use
 * - On module destroy, all connections are cleanly closed
 *
 * CRITICAL SECURITY RULE:
 * - The METAAPI_TOKEN is a platform-level secret — stored in env, NEVER per-user
 * - Per-user credentials are the MetaAPI accountId (UUID), stored encrypted in BrokerConnection
 *
 * See: docs/architecture/09-broker-integration-architecture.md §6
 */
@Injectable()
export class MetaApiClientService implements OnModuleDestroy {
  private readonly logger = new Logger(MetaApiClientService.name);
  private readonly metaApi: InstanceType<typeof MetaApi> | null;
  private readonly connectionPool = new Map<string, MetaApiConnectionEntry>();
  private readonly streamingConnectionPool = new Map<
    string,
    {
      account: any;
      connection: any;
      connectedAt: Date;
      accountId: string;
      subscribedSymbols: Set<string>;
    }
  >();
  private readonly streamingInitByAccount = new Map<string, Promise<any>>();
  private readonly streamingSubscriptionPromises = new Map<string, Promise<void>>();

  /** Synchronisation timeout — 60s for initial sync, 10s for re-checks */
  private readonly SYNC_TIMEOUT_SECONDS = 60;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('METAAPI_TOKEN', '');
    if (!token) {
      this.logger.warn(
        'METAAPI_TOKEN is not set. MetaTrader connections will not be available. ' +
          'Set METAAPI_TOKEN to enable live broker integration.',
      );
      this.metaApi = null;
    } else {
      this.metaApi = new MetaApi(token);
      this.logger.log('MetaAPI SDK initialised');
    }
  }

  isAvailable(): boolean {
    return this.metaApi !== null;
  }

  /**
   * Get or create an RPC connection for the given MetaAPI account ID.
   * Connection is cached in the pool and reused.
   * If the existing connection is not synchronised, it will reconnect.
   */
  async getOrCreateConnection(
    metaApiAccountId: string,
    options: { requireSynchronization?: boolean } = {},
  ): Promise<any> {
    const requireSynchronization = options.requireSynchronization ?? true;
    this.assertAvailable();

    const existing = this.connectionPool.get(metaApiAccountId);
    if (existing) {
      const conn = existing.connection;
      if (!requireSynchronization) {
        return conn;
      }
      if (typeof conn.isSynchronized === 'function' && conn.isSynchronized()) {
        return conn;
      }
      this.logger.warn(`Connection for account ${metaApiAccountId} lost sync — reconnecting`);
      this.connectionPool.delete(metaApiAccountId);
    }

    this.logger.log(`Creating MetaAPI connection for account: ${metaApiAccountId}`);

    const account = await this.metaApi!.metatraderAccountApi.getAccount(metaApiAccountId);

    if (!['DEPLOYED', 'DEPLOYING'].includes(account.state)) {
      this.logger.log(`Deploying MetaAPI account ${metaApiAccountId}...`);
      await account.deploy();
    }
    await account.waitDeployed();

    const connection = account.getRPCConnection();
    await connection.connect();
    if (requireSynchronization) {
      await connection.waitSynchronized(this.SYNC_TIMEOUT_SECONDS);
    }

    this.connectionPool.set(metaApiAccountId, {
      account,
      connection,
      connectedAt: new Date(),
      accountId: metaApiAccountId,
    });

    this.logger.log(`MetaAPI connection established for account: ${metaApiAccountId}`);
    return connection;
  }

  /**
   * Return provider-native streaming prices from MetaApi's local terminal-state cache.
   * A dedicated streaming connection is maintained per account alongside the RPC pool.
   * Subscriptions are idempotent and only created for requested symbols.
   */
  async getStreamingPrices(metaApiAccountId: string, instruments: string[]): Promise<any[]> {
    const symbols = [...new Set(instruments.map((v) => v.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) return [];
    const connection = await this.getOrCreateStreamingConnection(metaApiAccountId);
    const entry = this.streamingConnectionPool.get(metaApiAccountId);
    if (!entry) return [];

    await Promise.allSettled(
      symbols.map((symbol) => this.ensureStreamingSubscription(entry, symbol)),
    );

    return symbols
      .map((symbol) => connection.terminalState?.price?.(symbol))
      .filter(
        (price: any) =>
          price &&
          Number.isFinite(Number(price.bid)) &&
          Number.isFinite(Number(price.ask)) &&
          Number(price.bid) > 0 &&
          Number(price.ask) > 0,
      );
  }

  private async getOrCreateStreamingConnection(metaApiAccountId: string): Promise<any> {
    this.assertAvailable();
    const existing = this.streamingConnectionPool.get(metaApiAccountId);
    if (existing) return existing.connection;

    const inFlight = this.streamingInitByAccount.get(metaApiAccountId);
    if (inFlight) return inFlight;

    const init = (async () => {
      this.logger.log(`Creating MetaAPI streaming connection for account: ${metaApiAccountId}`);
      const account = await this.metaApi!.metatraderAccountApi.getAccount(metaApiAccountId);
      if (!['DEPLOYED', 'DEPLOYING'].includes(account.state)) {
        await account.deploy();
      }
      await account.waitDeployed();
      const connection = account.getStreamingConnection();
      await connection.connect();
      await connection.waitSynchronized({ timeoutInSeconds: this.SYNC_TIMEOUT_SECONDS });
      this.streamingConnectionPool.set(metaApiAccountId, {
        account,
        connection,
        connectedAt: new Date(),
        accountId: metaApiAccountId,
        subscribedSymbols: new Set<string>(),
      });
      this.logger.log(`MetaAPI streaming connection established for account: ${metaApiAccountId}`);
      return connection;
    })();

    this.streamingInitByAccount.set(metaApiAccountId, init);
    try {
      return await init;
    } finally {
      this.streamingInitByAccount.delete(metaApiAccountId);
    }
  }

  private async ensureStreamingSubscription(
    entry: { accountId: string; connection: any; subscribedSymbols: Set<string> },
    symbol: string,
  ): Promise<void> {
    if (entry.subscribedSymbols.has(symbol)) return;
    const key = `${entry.accountId}:${symbol}`;
    const existing = this.streamingSubscriptionPromises.get(key);
    if (existing) return existing;

    const subscribe = (async () => {
      try {
        await entry.connection.subscribeToMarketData(
          symbol,
          [{ type: 'quotes', intervalInMilliseconds: 2_000 }],
          15,
        );
        entry.subscribedSymbols.add(symbol);
        this.logger.log(`MetaAPI streaming quote subscription active symbol=${symbol}`);
      } catch (error) {
        this.logger.warn(
          `MetaAPI streaming quote subscription failed symbol=${symbol}: ${(error as Error).message}`,
        );
        throw error;
      }
    })();
    this.streamingSubscriptionPromises.set(key, subscribe);
    try {
      await subscribe;
    } finally {
      this.streamingSubscriptionPromises.delete(key);
    }
  }

  /**
   * Test that a MetaAPI accountId is accessible without caching the connection.
   * Returns the account state and basic info on success.
   */
  async testAccountAccess(
    metaApiAccountId: string,
  ): Promise<{ success: boolean; accountType?: string; currency?: string; error?: string }> {
    this.assertAvailable();
    try {
      const account = await this.metaApi!.metatraderAccountApi.getAccount(metaApiAccountId);
      const state = account.state;

      if (['UNDEPLOY_FAILED', 'DEPLOY_FAILED'].includes(state)) {
        return { success: false, error: `Account in failed state: ${state}` };
      }

      if (!['DEPLOYED', 'DEPLOYING'].includes(state)) {
        await account.deploy();
        await account.waitDeployed();
      }

      // Brief connection to verify access
      const conn = account.getRPCConnection();
      await conn.connect();
      await conn.waitSynchronized(30);

      const info = await conn.getAccountInformation();
      await conn.close();

      return {
        success: true,
        accountType: info.type?.includes('DEMO') ? 'DEMO' : 'LIVE',
        currency: info.currency,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Sprint 32 Gate 4: calculate required margin using MetaAPI's native
   * calculate-margin capability.
   *
   * Uses the RPC connection's calculateMargin(order) method, which calls
   * the official MetaAPI WebSocket calculateMargin request.
   *
   * Architecture: RiskService → BrokerService → MetaTraderAdapter →
   * MetaApiClientService.calculateMargin() → MetaAPI native API.
   *
   * @param metaApiAccountId - the MetaAPI account ID (UUID)
   * @param order - { symbol, type (ORDER_TYPE_BUY/SELL), volume, openPrice }
   * @returns margin as a decimal-safe string, or null if unavailable
   */
  async calculateMargin(
    metaApiAccountId: string,
    order: {
      symbol: string;
      type: string;
      volume: number;
      openPrice: number;
    },
  ): Promise<string | null> {
    this.assertAvailable();
    try {
      const connection = await this.getOrCreateConnection(metaApiAccountId);
      // The SDK's calculateMargin returns { margin?: number }
      const result = await connection.calculateMargin(order);

      if (result?.margin === undefined || result?.margin === null) {
        return null;
      }

      const margin = result.margin;
      if (!Number.isFinite(margin) || margin < 0) {
        return null;
      }

      // Return as decimal-safe string (no Float persisted)
      return margin.toFixed(2);
    } catch {
      this.logger.warn(
        'MetaAPI calculateMargin request failed; margin validation will fail closed',
      );
      return null;
    }
  }

  /**
   * Close and remove a connection from the pool.
   */
  async removeConnection(metaApiAccountId: string): Promise<void> {
    const entries = [
      this.connectionPool.get(metaApiAccountId)?.connection,
      this.streamingConnectionPool.get(metaApiAccountId)?.connection,
    ].filter(Boolean);
    for (const connection of entries) {
      try {
        await connection.close();
      } catch (err) {
        this.logger.warn(
          `Error closing connection for ${metaApiAccountId}: ${(err as Error).message}`,
        );
      }
    }
    this.connectionPool.delete(metaApiAccountId);
    this.streamingConnectionPool.delete(metaApiAccountId);
    for (const key of this.streamingSubscriptionPromises.keys()) {
      if (key.startsWith(`${metaApiAccountId}:`)) this.streamingSubscriptionPromises.delete(key);
    }
    if (entries.length > 0) {
      this.logger.log(`Removed MetaAPI connection for account: ${metaApiAccountId}`);
    }
  }

  /**
   * Get all active (pooled) MetaAPI account IDs.
   */
  getActiveAccountIds(): string[] {
    return Array.from(this.connectionPool.keys());
  }

  /**
   * Check if a specific account has an active pooled connection.
   */
  hasConnection(metaApiAccountId: string): boolean {
    return this.connectionPool.has(metaApiAccountId);
  }

  async onModuleDestroy() {
    const entries = [
      ...Array.from(this.connectionPool.entries()).map(([accountId, entry]) => ({
        accountId,
        connection: entry.connection,
      })),
      ...Array.from(this.streamingConnectionPool.entries()).map(([accountId, entry]) => ({
        accountId,
        connection: entry.connection,
      })),
    ];
    this.logger.log(`Closing ${entries.length} MetaAPI connection(s) on module destroy`);
    await Promise.allSettled(
      entries.map(async ({ accountId, connection }) => {
        try {
          await connection.close();
        } catch (err) {
          this.logger.warn(`Error closing ${accountId}: ${(err as Error).message}`);
        }
      }),
    );
    this.connectionPool.clear();
    this.streamingConnectionPool.clear();
    this.streamingInitByAccount.clear();
    this.streamingSubscriptionPromises.clear();
  }

  private assertAvailable(): void {
    if (!this.metaApi) {
      throw new ServiceUnavailableException(
        'MetaAPI integration is not configured. Set METAAPI_TOKEN environment variable.',
      );
    }
  }
}
