import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { DataSource } from 'typeorm';
import {
  DIRECT_MT5_COMMAND_TYPES,
  DIRECT_MT5_PROTOCOL_VERSION,
  DirectMt5Command,
  DirectMt5CommandType,
  parseDirectMt5Command,
} from './direct-mt5.protocol';

export interface EnqueueDirectMt5Command {
  connectorId: string;
  brokerConnectionId: string;
  idempotencyKey: string;
  commandType: DirectMt5CommandType;
  payload: Record<string, unknown>;
}

export interface DirectMt5StoredCommand {
  id: string;
  connector_id: string;
  broker_connection_id: string;
  idempotency_key: string;
  command_type: DirectMt5CommandType;
  payload: Record<string, unknown>;
  state: string;
}

export interface DirectMt5CommandResultInput {
  state: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';
  result: Record<string, unknown> | null;
  error: string | null;
}

@Injectable()
export class DirectMt5CommandUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectMt5CommandUncertainError'; }
}

export class DirectMt5CommandService {
  constructor(private readonly dataSource: DataSource) {}

  async enqueue(input: EnqueueDirectMt5Command): Promise<DirectMt5StoredCommand> {
    if (!(DIRECT_MT5_COMMAND_TYPES as readonly string[]).includes(input.commandType)) {
      throw new ConflictException(`Unsupported direct MT5 command type: ${input.commandType}`);
    }
    if (!input.idempotencyKey?.trim()) {
      throw new ConflictException('Direct MT5 command idempotency key is required');
    }

    const commandId = randomUUID();
    const inserted = (await this.dataSource.query(
      `
        INSERT INTO broker.direct_mt5_commands (
          id, connector_id, broker_connection_id, idempotency_key,
          command_type, payload, state, created_at, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6::jsonb, 'PENDING', now(), now()
        WHERE EXISTS (
          SELECT 1
          FROM broker.direct_mt5_connectors c
          WHERE c.id = $2
            AND c.broker_connection_id = $3
            AND c.state = 'ACTIVE'
        )
        ON CONFLICT (broker_connection_id, idempotency_key) DO NOTHING
        RETURNING id, connector_id, broker_connection_id, idempotency_key,
                  command_type, payload, state
      `,
      [
        commandId,
        input.connectorId,
        input.brokerConnectionId,
        input.idempotencyKey,
        input.commandType,
        JSON.stringify(input.payload),
      ],
    )) as DirectMt5StoredCommand[];
    if (inserted[0]) return inserted[0];

    const existing = (await this.dataSource.query(
      `
        SELECT id, connector_id, broker_connection_id, idempotency_key,
               command_type, payload, state
        FROM broker.direct_mt5_commands
        WHERE broker_connection_id = $1
          AND idempotency_key = $2
        LIMIT 1
      `,
      [input.brokerConnectionId, input.idempotencyKey],
    )) as DirectMt5StoredCommand[];
    const command = existing[0];
    if (!command) {
      throw new NotFoundException('Direct MT5 connector is not active for this broker connection');
    }
    if (
      command.connector_id !== input.connectorId ||
      command.command_type !== input.commandType ||
      !isDeepStrictEqual(command.payload, input.payload)
    ) {
      throw new ConflictException(
        'Direct MT5 idempotency key was already used for different command semantics',
      );
    }
    return command;
  }

  async leaseNext(connectorId: string): Promise<DirectMt5Command | null> {
    // A timed-out mutation may already have reached MT5. Never put mutations
    // back in PENDING: mark them UNCERTAIN and require provider reconciliation.
    // Read-only commands have no provider-side mutation to reconcile, so an
    // expired read lease can be safely cancelled and requested again later.
    await this.dataSource.query(
      `
        WITH uncertain AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'UNCERTAIN',
              error = COALESCE(
                error,
                'command lease expired after possible MT5 mutation; reconcile provider state'
              ),
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = now()
          WHERE connector_id = $1
            AND state = 'LEASED'
            AND lease_expires_at <= now()
            AND (
              command_type = 'PLACE_ORDER'
              OR command_type IN ('MODIFY_ORDER', 'CLOSE_ORDER', 'CLOSE_ALL')
            )
          RETURNING id
        ), cancelled AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'CANCELLED',
              error = COALESCE(error, 'read-only command lease expired before authoritative result'),
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
          WHERE connector_id = $1
            AND state = 'LEASED'
            AND lease_expires_at <= now()
            AND command_type NOT IN ('PLACE_ORDER', 'MODIFY_ORDER', 'CLOSE_ORDER', 'CLOSE_ALL')
          RETURNING id
        )
        SELECT 1
      `,
      [connectorId],
    );

    const rows = (await this.dataSource.query(
      `
        WITH candidate AS (
          SELECT cmd.id
          FROM broker.direct_mt5_commands cmd
          JOIN broker.direct_mt5_connectors c ON c.id = cmd.connector_id
          WHERE cmd.connector_id = $1
            AND cmd.state = 'PENDING'
            AND c.state = 'ACTIVE'
            AND c.last_heartbeat_at >= now() - interval '15 seconds'
            AND (cmd.command_type <> 'PLACE_ORDER' OR c.trade_allowed = true)
            AND (
              cmd.command_type NOT IN ('MODIFY_ORDER', 'CLOSE_ORDER', 'CLOSE_ALL')
              OR c.trade_allowed = true
            )
          ORDER BY cmd.created_at ASC
          FOR UPDATE OF cmd SKIP LOCKED
          LIMIT 1
        )
        UPDATE broker.direct_mt5_commands cmd
        SET state = 'LEASED',
            lease_owner = replace(gen_random_uuid()::text, '-', ''),
            lease_expires_at = now() + interval '30 seconds',
            updated_at = now()
        FROM candidate, broker.direct_mt5_connectors c
        WHERE cmd.id = candidate.id
          AND c.id = cmd.connector_id
        RETURNING cmd.id, cmd.connector_id, cmd.broker_connection_id,
                  cmd.idempotency_key, cmd.command_type, cmd.payload,
                  cmd.created_at, cmd.lease_expires_at,
                  c.account_login, c.broker_server
      `,
      [connectorId],
    )) as Array<{
      id: string;
      connector_id: string;
      broker_connection_id: string;
      idempotency_key: string;
      command_type: DirectMt5CommandType;
      payload: Record<string, unknown>;
      created_at: string | Date;
      lease_expires_at: string | Date;
      account_login: string;
      broker_server: string;
    }>;
    const row = rows[0];
    if (!row) return null;

    return parseDirectMt5Command({
      protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
      commandId: row.id,
      idempotencyKey: row.idempotency_key,
      connectorId: row.connector_id,
      brokerConnectionId: row.broker_connection_id,
      accountLogin: row.account_login,
      brokerServer: row.broker_server,
      commandType: row.command_type,
      createdAt: new Date(row.created_at).toISOString(),
      leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
      payload: row.payload,
    });
  }

  async recordResult(
    connectorId: string,
    commandId: string,
    input: DirectMt5CommandResultInput,
  ): Promise<{ id: string; state: string }> {
    const rows = (await this.dataSource.query(
      `
        UPDATE broker.direct_mt5_commands
        SET state = $3,
            result = $4::jsonb,
            error = $5,
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = CASE WHEN $3 IN ('SUCCEEDED','FAILED') THEN now() ELSE completed_at END,
            updated_at = now()
        WHERE connector_id = $1
          AND id = $2
          AND state IN ('LEASED','UNCERTAIN')
        RETURNING id, state
      `,
      [connectorId, commandId, input.state, JSON.stringify(input.result), input.error],
    )) as Array<{ id: string; state: string }>;
    const command = rows[0];
    if (!command) {
      throw new NotFoundException('Direct MT5 command is not leased by this connector');
    }
    return command;
  }

  async getActiveConnectorForConnection(brokerConnectionId: string): Promise<{
    connectorId: string;
    accountLogin: string;
    brokerServer: string;
    currency: string | null;
    tradeAllowed: boolean;
  }> {
    const rows = (await this.dataSource.query(
      `SELECT id, account_login, broker_server, currency, trade_allowed
       FROM broker.direct_mt5_connectors
       WHERE broker_connection_id = $1
         AND state = 'ACTIVE'
         AND last_heartbeat_at >= now() - interval '15 seconds'
       LIMIT 1`,
      [brokerConnectionId],
    )) as Array<{id:string;account_login:string;broker_server:string;currency:string|null;trade_allowed:boolean}>;
    const row = rows[0];
    if (!row) throw new NotFoundException('Direct MT5 connector is not active or heartbeat is stale');
    return { connectorId: row.id, accountLogin: row.account_login, brokerServer: row.broker_server, currency: row.currency, tradeAllowed: Boolean(row.trade_allowed) };
  }

  async request(input: {
    brokerConnectionId: string;
    idempotencyKey: string;
    commandType: DirectMt5CommandType;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const connector = await this.getActiveConnectorForConnection(input.brokerConnectionId);
    const command = await this.enqueue({
      connectorId: connector.connectorId,
      brokerConnectionId: input.brokerConnectionId,
      idempotencyKey: input.idempotencyKey,
      commandType: input.commandType,
      payload: input.payload,
    });
    const deadline = Date.now() + Math.max(500, Math.min(input.timeoutMs ?? 9_000, 25_000));
    while (Date.now() < deadline) {
      const rows = (await this.dataSource.query(
        `SELECT state, result, error FROM broker.direct_mt5_commands WHERE id = $1 LIMIT 1`,
        [command.id],
      )) as Array<{state:string;result:Record<string, unknown>|null;error:string|null}>;
      const row = rows[0];
      if (!row) throw new NotFoundException('Direct MT5 command disappeared before completion');
      if (row.state === 'SUCCEEDED') return row.result ?? {};
      if (row.state === 'FAILED') throw new ConflictException(row.error ?? 'Direct MT5 terminal command failed');
      if (row.state === 'UNCERTAIN') throw new DirectMt5CommandUncertainError(row.error ?? 'Direct MT5 command outcome is uncertain');
      if (row.state === 'CANCELLED') throw new ConflictException(row.error ?? 'Direct MT5 command was cancelled');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mutation = ['PLACE_ORDER','MODIFY_ORDER','CLOSE_ORDER','CLOSE_ALL'].includes(input.commandType);
    if (mutation) throw new DirectMt5CommandUncertainError('Direct MT5 command timed out after enqueue; reconcile terminal state before any retry');
    throw new ConflictException('Direct MT5 terminal did not answer the read command before timeout');
  }

}
