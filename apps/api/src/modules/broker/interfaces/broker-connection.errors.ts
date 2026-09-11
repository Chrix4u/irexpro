import { ConflictException } from '@nestjs/common';
import { BrokerConnection } from '../entities/broker-connection.entity';

/**
 * BrokerLogicalAccountConflictError — the durable idempotency conflict
 * (Sprint 56 correction round 5, architect issue #332).
 *
 * Thrown by BrokerService.createConnection when the logical-account INSERT
 * hit the per-user partial unique index
 * (uq_broker_connections_logical_account): a non-deleted connection for the
 * SAME logical broker account already exists.
 *
 * The error CARRIES the existing connection so the OAuth linking path can
 * ADOPT it (converge the flow to CONSUMED, return the existing row — no
 * second durable connection). For manual (non-OAuth) connects it propagates
 * as an honest 409 Conflict (ConflictException subclass).
 */
export class BrokerLogicalAccountConflictError extends ConflictException {
  readonly logicalAccountKey: string;
  readonly existingConnection: BrokerConnection;

  constructor(logicalAccountKey: string, existingConnection: BrokerConnection) {
    super(
      'A broker connection for this account already exists — the existing connection was ' +
        'kept (one durable connection per logical broker account per user). Use the existing ' +
        'connection or disconnect it before connecting again.',
    );
    this.name = 'BrokerLogicalAccountConflictError';
    this.logicalAccountKey = logicalAccountKey;
    this.existingConnection = existingConnection;
  }
}
