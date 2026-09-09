import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BrokerService } from './broker.service';
import { BrokerController } from './broker.controller';
import { BrokerOAuthController } from './broker-oauth.controller';
import { BrokerOAuthCallbackController } from './broker-oauth-callback.controller';
import { PortfolioController } from './portfolio.controller';
import { BrokerRegistryController } from './broker-registry.controller';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerOAuthFlow } from './entities/broker-oauth-flow.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { MetaTraderAdapter } from './adapters/metatrader.adapter';
import { PaperBrokerAdapter } from './adapters/paper-broker.adapter';
import { OandaAdapter } from './adapters/oanda/oanda.adapter';
import { CTraderAdapter } from './adapters/ctrader/ctrader.adapter';
import { CTraderClientService } from './adapters/ctrader/ctrader-client.service';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { MetaApiClientService } from './services/metaapi-client.service';
import { PortfolioReadService } from './services/portfolio-read.service';
import { BrokerDemoValidationService } from './services/broker-demo-validation.service';
import { BrokerOAuthTokenLifecycleService } from './services/broker-oauth-token-lifecycle.service';
import { BrokerOAuthService } from './services/broker-oauth.service';
import { BrokerProviderRegistryService } from './registry/broker-provider-registry.service';
import { BrokerHealthCheckJob, BROKER_HEALTH_QUEUE } from './jobs/broker-health-check.job';
import { BrokerHealthCheckProducer } from './jobs/broker-health-check.producer';
import { AuditModule } from '../audit/audit.module';

/**
 * BrokerModule — Pluggable broker integration layer with health monitoring.
 *
 * Architecture summary:
 * - BrokerAdapterRegistry: pluggable adapter pattern (add new broker = new adapter)
 * - MetaApiClientService: MetaAPI SDK lifecycle and RPC connection pool
 * - CredentialEncryptionService: AES-256-GCM credential encryption
 * - PortfolioReadService: frontend-safe, currency-aware persisted account snapshots
 * - BrokerHealthCheckJob: BullMQ job processor (runs every 60s)
 * - BrokerHealthCheckProducer: schedules the repeatable health check on startup
 *
 * Adding a new broker adapter:
 *   1. Implement IBrokerAdapter
 *   2. Add the metadata/root adapter to the providers list
 *   3. Register it in onModuleInit WITH a connection-isolation factory
 *      (registry.register(adapter, factory)) — the root instance stays
 *      metadata-only; persisted BrokerConnections receive fresh mutable
 *      adapter contexts per connection id (#291 / correction round 3)
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BrokerConnection, BrokerAccount, BrokerOAuthFlow]),
    BullModule.registerQueue({ name: BROKER_HEALTH_QUEUE }),
    AuditModule,
  ],
  controllers: [
    BrokerOAuthController,
    // Sprint 56 correction round 2 (architect finding 4) — the UNAUTHENTICATED
    // server-side provider callback for mobile flows (public route; carries
    // no user data, grants nothing without the single-use provider code).
    BrokerOAuthCallbackController,
    BrokerController,
    BrokerRegistryController,
    PortfolioController,
  ],
  providers: [
    BrokerService,
    PortfolioReadService,
    // Sprint 56 / Task 48-D — evidence-based write path for
    // BrokerConnection.demoValidated
    // (POST /broker/connections/:connectionId/validate-demo).
    BrokerDemoValidationService,
    // Sprint 56 correction round 1 (audit point 1) — OAuth token freshness
    // for the cTrader family (refresh + ATOMIC pair persistence, fail-closed
    // INVALID on rejection). Consumed by BrokerService connect/health paths.
    BrokerOAuthTokenLifecycleService,
    // Sprint 56 correction round 1 (audit point 6) — the user-facing OAuth
    // connection flow (authorize → external consent → complete → link) with
    // server-side single-use flow correlation. Sprint 56 correction round 2
    // (architect finding 2): the flow store moved from a process-local Map to
    // the shared broker.broker_oauth_flows table (PostgreSQL) — replica-safe
    // and restart-safe, with encrypted token columns and CAS state
    // transitions.
    BrokerOAuthService,
    CredentialEncryptionService,
    MetaApiClientService,
    // Sprint 56 / Task 48-B — the platform-level cTrader Open API connection
    // manager (JSON-WebSocket, OAuth2, heartbeat, rate limits, reconnect).
    // Owns ALL cTrader provider connections; the adapter stays a mapping layer.
    CTraderClientService,
    BrokerAdapterRegistry,
    BrokerProviderRegistryService,
    MetaTraderAdapter,
    PaperBrokerAdapter,
    OandaAdapter,
    CTraderAdapter,
    BrokerHealthCheckJob,
    BrokerHealthCheckProducer,
  ],
  exports: [
    BrokerService,
    PortfolioReadService,
    BrokerAdapterRegistry,
    BrokerProviderRegistryService,
    PaperBrokerAdapter,
    // CredentialEncryptionService is exported so that ExecutionModule (which
    // imports BrokerModule) can inject it into ExecutionService, where it is
    // used to decrypt broker credentials immediately before placing an order.
    // Without this export, NestJS cannot resolve CredentialEncryptionService in
    // the ExecutionModule context at runtime (staging bootstrap DI failure,
    // Sprint 20). The service remains a single provider owned by BrokerModule —
    // it is NOT re-declared anywhere else.
    CredentialEncryptionService,
    // Exported for account-scoped, read-only MetaTrader market data. Consumers
    // must never expose the provider account reference outside the server.
    MetaApiClientService,
  ],
})
export class BrokerModule implements OnModuleInit {
  constructor(
    private registry: BrokerAdapterRegistry,
    private metaTraderAdapter: MetaTraderAdapter,
    private paperBrokerAdapter: PaperBrokerAdapter,
    private oandaAdapter: OandaAdapter,
    private cTraderAdapter: CTraderAdapter,
    private metaApiClient: MetaApiClientService,
    private configService: ConfigService,
    private cTraderClient: CTraderClientService,
  ) {}

  onModuleInit() {
    // Root adapters are metadata-only (#291 / Sprint 56 correction round 3,
    // architect findings 1 + 2 + 7). Every persisted BrokerConnection gets a
    // fresh mutable adapter context from these factories. Lower-level
    // provider infrastructure (the MetaAPI connection pool, the cTrader
    // environment-connection pool) remains shared underneath by design.
    this.registry.register(
      this.metaTraderAdapter,
      () => new MetaTraderAdapter(this.metaApiClient),
    );
    this.registry.register(this.paperBrokerAdapter, () => new PaperBrokerAdapter());
    // Sprint 51 PR-7 — OANDA v20 REST native adapter (BETA: implemented +
    // contract-tested; live verification pending — see
    // docs/brokers/oanda-v20-adapter.md).
    this.registry.register(this.oandaAdapter, () => new OandaAdapter(this.configService));
    // Sprint 56 / Task 48-B + correction round 3 — the universal cTrader Open
    // API engine (BETA: implemented + contract-tested; connections fail
    // closed until the operator supplies CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET
    // — Spotware partner approval — and production-LIVE stays UNVERIFIED).
    // The Pepperstone / IC Markets catalog entries are ALIASES: they share
    // the canonical factory + client infrastructure, NEVER the mutable
    // adapter object. The requested alias broker id is preserved on the
    // isolated adapter so broker-specific identity verification (discovered
    // brokerTitleShort) can fail closed on brand mismatch.
    this.registry.register(
      this.cTraderAdapter,
      (requestedBrokerId: string) => new CTraderAdapter(this.cTraderClient, requestedBrokerId),
    );
    this.registry.registerBrokerAlias('pepperstone-ctrader', this.cTraderAdapter);
    this.registry.registerBrokerAlias('icmarkets-ctrader', this.cTraderAdapter);
  }
}
