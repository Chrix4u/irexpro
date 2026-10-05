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
    const entry = this.connectionPool.get(metaApiAccountId);
    if (entry) {
      try {
        await entry.connection.close();
      } catch (err) {
        this.logger.warn(
          `Error closing connection for ${metaApiAccountId}: ${(err as Error).message}`,
        );
      }
      this.connectionPool.delete(metaApiAccountId);
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
    this.logger.log(`Closing ${this.connectionPool.size} MetaAPI connection(s) on module destroy`);
    const closePromises = Array.from(this.connectionPool.entries()).map(
      async ([accountId, entry]) => {
        try {
          await entry.connection.close();
        } catch (err) {
          this.logger.warn(`Error closing ${accountId}: ${(err as Error).message}`);
        }
      },
    );
    await Promise.allSettled(closePromises);
    this.connectionPool.clear();
  }

  private assertAvailable(): void {
    if (!this.metaApi) {
      throw new ServiceUnavailableException(
        'MetaAPI integration is not configured. Set METAAPI_TOKEN environment variable.',
      );
    }
  }
}
