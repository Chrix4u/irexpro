import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrokerService } from './broker.service';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { BrokerOAuthTokenLifecycleService } from './services/broker-oauth-token-lifecycle.service';
import { BrokerLinkOutboxService } from './services/broker-link-outbox.service';
import { BrokerProviderRegistryService } from './registry/broker-provider-registry.service';
import { BrokerAccountSnapshotService } from './services/broker-account-snapshot.service';
import { BrokerAuthorizationStatus } from './authorization/broker-authorization-status';
import { BrokerMode } from './interfaces/broker-adapter.interface';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';

/**
 * BrokerService specialization for the built-in paper simulator.
 *
 * Real broker connections retain the base ACTIVE-only execution gate. The
 * built-in paper-broker is intentionally different: the connection IS the
 * simulator itself — a successful DEMO handshake (which settles the
 * connection at CONNECTED, the pre-validation state) is all the "trading
 * surface" a simulation needs. PAPER_ONLY execution may therefore use
 * CONNECTED/AUTHORIZED/READY/ACTIVE only for the paper-broker DEMO identity
 * (CONNECTED covers connect-then-simulate; AUTHORIZED/READY/ACTIVE cover
 * connections that additionally passed the DEMO validation checklist).
 * No LIVE or real-broker authorization is widened: for every other broker
 * the DEMO validation checklist remains the sole CONNECTED → AUTHORIZED
 * authority, and real-broker execution stays ACTIVE-only.
 */
@Injectable()
export class ExecutionAwareBrokerService extends BrokerService {
  constructor(
    @InjectRepository(BrokerConnection)
    connectionRepo: Repository<BrokerConnection>,
    @InjectRepository(BrokerAccount)
    accountRepo: Repository<BrokerAccount>,
    adapterRegistry: BrokerAdapterRegistry,
    providerRegistry: BrokerProviderRegistryService,
    encryptionService: CredentialEncryptionService,
    auditService: AuditService,
    eventBus: DomainEventBus,
    tokenLifecycle: BrokerOAuthTokenLifecycleService,
    linkOutbox: BrokerLinkOutboxService,
    tradingAuthorityService: TradingAuthorityService,
    grantInvalidation: GrantInvalidationService,
    snapshotService: BrokerAccountSnapshotService,
  ) {
    super(
      connectionRepo,
      accountRepo,
      adapterRegistry,
      providerRegistry,
      encryptionService,
      auditService,
      eventBus,
      tokenLifecycle,
      linkOutbox,
      tradingAuthorityService,
      grantInvalidation,
      snapshotService,
    );
  }

  override isConnectionExecutable(connection: BrokerConnection): boolean {
    if (connection.brokerId === 'paper-broker' && connection.accountType === BrokerMode.DEMO) {
      return (
        connection.authorizationStatus === BrokerAuthorizationStatus.CONNECTED ||
        connection.authorizationStatus === BrokerAuthorizationStatus.AUTHORIZED ||
        connection.authorizationStatus === BrokerAuthorizationStatus.READY ||
        connection.authorizationStatus === BrokerAuthorizationStatus.ACTIVE
      );
    }

    return super.isConnectionExecutable(connection);
  }
}
