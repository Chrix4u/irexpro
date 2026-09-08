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
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { MetaApiClientService } from './services/metaapi-client.service';
import { PortfolioReadService } from './services/portfolio-read.service';
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
    CredentialEncryptionService,
    MetaApiClientService,
    BrokerAdapterRegistry,
    BrokerProviderRegistryService,
    MetaTraderAdapter,
    PaperBrokerAdapter,
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
  ) {}

  onModuleInit() {
    this.registry.register(this.metaTraderAdapter);
    this.registry.register(this.paperBrokerAdapter);
    // Future: this.registry.register(this.oandaAdapter);
    // Future: this.registry.register(this.cTraderAdapter);
  }
}
