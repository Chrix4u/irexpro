import { randomUUID } from 'crypto';
import type { DirectMt5CommandType } from '../../direct-mt5/direct-mt5.protocol';
import type { EnqueueDirectMt5Command } from '../../direct-mt5/direct-mt5-command.service';
import {
  MT5_BRIDGE_PROTOCOL_VERSION,
  Mt5BridgeAccountIdentity,
  Mt5BridgeCapabilities,
  Mt5BridgeCommand,
  Mt5BridgeCommandName,
  Mt5BridgeResponse,
  Mt5BridgeSession,
  sameMt5Identity,
} from './mt5-bridge-protocol';

export type DirectMt5OutcomeState =
  | 'PENDING'
  | 'LEASED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNCERTAIN'
  | 'CANCELLED';

export interface DirectMt5CommandOutcome {
  state: DirectMt5OutcomeState;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface DirectMt5BridgeCommandClient {
  enqueue(input: EnqueueDirectMt5Command): Promise<{ id: string }>;
  waitForOutcome(commandId: string, maxWaitMs?: number): Promise<DirectMt5CommandOutcome>;
}

export interface DirectMt5BridgeSessionInput {
  connectorId: string;
  brokerConnectionId: string;
  identity: Mt5BridgeAccountIdentity;
  capabilities: Mt5BridgeCapabilities;
  lastHeartbeatAt: Date;
  commands: DirectMt5BridgeCommandClient;
}

/**
 * Durable Mt5BridgeSession backed by the authenticated direct-MT5 connector queue.
 *
 * The NativeMetaTrader5Adapter remains transport-agnostic. This session translates
 * its native bridge RPC vocabulary into restart-safe command leases consumed by the
 * Windows connector, then maps the durable result back into a bridge response.
 */
export class DirectMt5BridgeSession implements Mt5BridgeSession {
  readonly sessionId: string;
  readonly identity: Mt5BridgeAccountIdentity;
  readonly capabilities: Mt5BridgeCapabilities;
  lastHeartbeatAt: Date;

  private readonly connectorId: string;
  private readonly brokerConnectionId: string;
  private readonly commands: DirectMt5BridgeCommandClient;

  constructor(input: DirectMt5BridgeSessionInput) {
    this.connectorId = input.connectorId;
    this.brokerConnectionId = input.brokerConnectionId;
    this.sessionId = input.connectorId;
    this.identity = { ...input.identity };
    this.capabilities = { ...input.capabilities };
    this.lastHeartbeatAt = new Date(input.lastHeartbeatAt);
    this.commands = input.commands;
  }

  refresh(input: {
    identity: Mt5BridgeAccountIdentity;
    capabilities: Mt5BridgeCapabilities;
    lastHeartbeatAt: Date;
  }): void {
    if (!sameMt5Identity(this.identity, input.identity)) {
      throw new Error('Direct MT5 heartbeat identity changed; re-pairing is required');
    }
    Object.assign(this.identity, input.identity);
    Object.assign(this.capabilities, input.capabilities);
    this.lastHeartbeatAt = new Date(input.lastHeartbeatAt);
  }

  async request(command: Mt5BridgeCommand): Promise<Mt5BridgeResponse> {
    if (command.sessionId !== this.sessionId) {
      return this.rejection(
        command,
        'SESSION_MISMATCH',
        'Bridge session mismatch',
        'KNOWN_NOT_SENT',
      );
    }

    const mapped = this.mapCommand(command);
    if (!mapped) {
      return this.rejection(
        command,
        'UNSUPPORTED_COMMAND',
        `Direct MT5 connector does not yet implement ${command.commandName}`,
        'KNOWN_NOT_SENT',
      );
    }

    const stored = await this.commands.enqueue({
      connectorId: this.connectorId,
      brokerConnectionId: this.brokerConnectionId,
      idempotencyKey: command.idempotencyKey?.trim() || `read:${command.requestId}`,
      commandType: mapped.commandType,
      payload: mapped.payload,
    });
    const outcome = await this.commands.waitForOutcome(stored.id, 4_500);

    if (outcome.state === 'SUCCEEDED') {
      return {
        protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
        type: 'RESPONSE',
        sessionId: this.sessionId,
        requestId: command.requestId,
        sequence: command.sequence,
        sentAt: new Date().toISOString(),
        nonce: randomUUID(),
        ok: true,
        payload: this.normalizeResult(command.commandName, outcome.result ?? {}),
      };
    }

    const certainty =
      outcome.state === 'PENDING' || outcome.state === 'CANCELLED'
        ? 'KNOWN_NOT_SENT'
        : outcome.state === 'LEASED' || outcome.state === 'UNCERTAIN'
          ? 'UNCERTAIN'
          : 'REJECTED';
    return this.rejection(
      command,
      outcome.state === 'FAILED' ? 'PROVIDER_REJECTED' : `COMMAND_${outcome.state}`,
      outcome.error ?? `Direct MT5 command ended in ${outcome.state}`,
      certainty,
    );
  }

  private mapCommand(command: Mt5BridgeCommand): {
    commandType: DirectMt5CommandType;
    payload: Record<string, unknown>;
  } | null {
    const payload = this.record(command.payload);
    const ownership = command.ownership ? { ...command.ownership } : undefined;

    switch (command.commandName) {
      case 'GET_ACCOUNT_INFO':
        return { commandType: 'ACCOUNT_SNAPSHOT', payload: {} };
      case 'GET_TICK':
        return {
          commandType: 'GET_PRICE',
          payload: { symbol: payload.instrument },
        };
      case 'GET_RATES':
        return {
          commandType: 'GET_OHLCV',
          payload: {
            symbol: payload.instrument,
            timeframe: payload.timeframe,
            count: payload.count,
            before: payload.before,
          },
        };
      case 'CALCULATE_MARGIN':
        return {
          commandType: 'CALCULATE_MARGIN',
          payload: {
            symbol: payload.instrument,
            side: payload.direction,
            volume: payload.lotSize,
          },
        };
      case 'LIST_POSITIONS':
        return { commandType: 'LIST_POSITIONS', payload };
      case 'LIST_ORDERS':
        return { commandType: 'LIST_ORDERS', payload };
      case 'GET_ORDER':
        return { commandType: 'GET_ORDER', payload };
      case 'GET_HISTORY':
        return { commandType: 'GET_HISTORY', payload };
      case 'PLACE_ORDER':
        return {
          commandType: 'PLACE_ORDER',
          payload: {
            ...payload,
            symbol: payload.instrument,
            side: payload.direction,
            volume: payload.lotSize,
            ownership,
          },
        };
      case 'MODIFY_ORDER':
        return {
          commandType: 'MODIFY_ORDER',
          payload: {
            ...payload,
            positionTicket: payload.externalOrderId,
            stopLoss: payload.newStopLoss,
            takeProfit: payload.newTakeProfit,
            ownership,
          },
        };
      case 'CLOSE_POSITION':
        return {
          commandType: 'CLOSE_ORDER',
          payload: {
            ...payload,
            positionTicket: payload.externalOrderId,
            volume: payload.lotSize,
            ownership,
          },
        };
      case 'CLOSE_IREXPRO_POSITIONS':
        return { commandType: 'CLOSE_ALL', payload: { ...payload, ownership } };
      case 'GET_SYMBOLS':
      case 'CANCEL_ORDER':
        return null;
    }
  }

  private normalizeResult(
    commandName: Mt5BridgeCommandName,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (commandName) {
      case 'GET_ACCOUNT_INFO':
        return {
          ...result,
          accountId: result.accountId ?? result.login,
        };
      case 'GET_TICK': {
        const timeMsc = Number(result.timeMsc);
        return {
          ...result,
          instrument: result.instrument ?? result.symbol,
          timestamp:
            result.timestamp ??
            (Number.isFinite(timeMsc) ? new Date(timeMsc).toISOString() : new Date().toISOString()),
        };
      }
      case 'CALCULATE_MARGIN':
        return { ...result, requiredMargin: result.requiredMargin ?? result.margin ?? null };
      default:
        return result;
    }
  }

  private rejection(
    command: Mt5BridgeCommand,
    code: string,
    message: string,
    certainty: 'REJECTED' | 'UNCERTAIN' | 'KNOWN_NOT_SENT',
  ): Mt5BridgeResponse {
    return {
      protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
      type: 'RESPONSE',
      sessionId: this.sessionId,
      requestId: command.requestId,
      sequence: command.sequence,
      sentAt: new Date().toISOString(),
      nonce: randomUUID(),
      ok: false,
      error: { code, message, certainty },
    };
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }
}
