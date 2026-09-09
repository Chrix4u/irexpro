import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BrokerService } from './broker.service';
import { BrokerController } from './broker.controller';
import { PortfolioController } from './portfolio.controller';
import { BrokerRegistryController } from './broker-registry.controller';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
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
 *   2. Add to providers list
 *   3. Call registry.register(adapter) in onModuleInit
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BrokerConnection, BrokerAccount]),
    BullModule.registerQueue({ name: BROKER_HEALTH_QUEUE }),
    AuditModule,
  ],
  controllers: [BrokerController, BrokerRegistryController, PortfolioController],
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
  ) {}

  onModuleInit() {
    this.registry.register(this.metaTraderAdapter);
    this.registry.register(this.paperBrokerAdapter);
    // Sprint 51 PR-7 — OANDA v20 REST native adapter (BETA: implemented +
    // contract-tested; live verification pending — see
    // docs/brokers/oanda-v20-adapter.md).
    this.registry.register(this.oandaAdapter);
    // Sprint 56 / Task 48-B — universal cTrader Open API engine (BETA:
    // implemented + contract-tested; connections fail closed until the
    // operator supplies CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET — Spotware
    // partner approval — and production-LIVE stays UNVERIFIED). The
    // Pepperstone / IC Markets catalog entries share this one engine.
    this.registry.register(this.cTraderAdapter);
    this.registry.registerBrokerAlias('pepperstone-ctrader', this.cTraderAdapter);
    this.registry.registerBrokerAlias('icmarkets-ctrader', this.cTraderAdapter);
  }
}
