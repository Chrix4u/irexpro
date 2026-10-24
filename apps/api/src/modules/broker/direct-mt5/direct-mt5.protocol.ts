export const DIRECT_MT5_PROTOCOL_VERSION = 'irexpro-direct-mt5-v1' as const;

export const DIRECT_MT5_COMMAND_TYPES = [
  'ACCOUNT_SNAPSHOT',
  'GET_PRICE',
  'GET_OHLCV',
  'CALCULATE_MARGIN',
  'PLACE_ORDER',
  'MODIFY_ORDER',
  'CLOSE_ORDER',
  'CLOSE_ALL',
  'LIST_POSITIONS',
  'LIST_ORDERS',
  'GET_ORDER',
  'GET_HISTORY',
] as const;

export const DIRECT_MT5_EVENT_TYPES = [
  'HELLO',
  'HEARTBEAT',
  'ACCOUNT_STATE',
  'COMMAND_RESULT',
  'POSITION_EVENT',
  'ORDER_EVENT',
  'DEAL_EVENT',
  'ERROR',
] as const;

export type DirectMt5CommandType = (typeof DIRECT_MT5_COMMAND_TYPES)[number];
export type DirectMt5EventType = (typeof DIRECT_MT5_EVENT_TYPES)[number];

export interface DirectMt5Command {
  protocolVersion: typeof DIRECT_MT5_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  connectorId: string;
  brokerConnectionId: string;
  accountLogin: string;
  brokerServer: string;
  commandType: DirectMt5CommandType;
  createdAt: string;
  leaseExpiresAt: string;
  payload: Record<string, unknown>;
}

export interface DirectMt5Event {
  protocolVersion: typeof DIRECT_MT5_PROTOCOL_VERSION;
  eventId: string;
  connectorId: string;
  brokerConnectionId: string;
  accountLogin: string;
  brokerServer: string;
  eventType: DirectMt5EventType;
  sequence: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requiredIsoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${key} must be an ISO timestamp`);
  }
  return value;
}

function requiredPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record.payload;
  assertRecord(payload, 'payload');
  return payload;
}

function assertProtocolVersion(record: Record<string, unknown>): void {
  if (record.protocolVersion !== DIRECT_MT5_PROTOCOL_VERSION) {
    throw new Error(`protocolVersion must be ${DIRECT_MT5_PROTOCOL_VERSION}`);
  }
}

export function parseDirectMt5Command(value: unknown): DirectMt5Command {
  assertRecord(value, 'command');
  assertProtocolVersion(value);

  const commandType = requiredString(value, 'commandType');
  if (!(DIRECT_MT5_COMMAND_TYPES as readonly string[]).includes(commandType)) {
    throw new Error(`commandType is unsupported: ${commandType}`);
  }

  const createdAt = requiredIsoTimestamp(value, 'createdAt');
  const leaseExpiresAt = requiredIsoTimestamp(value, 'leaseExpiresAt');
  if (Date.parse(leaseExpiresAt) <= Date.parse(createdAt)) {
    throw new Error('leaseExpiresAt must be after createdAt');
  }

  return {
    protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
    commandId: requiredString(value, 'commandId'),
    idempotencyKey: requiredString(value, 'idempotencyKey'),
    connectorId: requiredString(value, 'connectorId'),
    brokerConnectionId: requiredString(value, 'brokerConnectionId'),
    accountLogin: requiredString(value, 'accountLogin'),
    brokerServer: requiredString(value, 'brokerServer'),
    commandType: commandType as DirectMt5CommandType,
    createdAt,
    leaseExpiresAt,
    payload: requiredPayload(value),
  };
}

export function parseDirectMt5Event(value: unknown): DirectMt5Event {
  assertRecord(value, 'event');
  assertProtocolVersion(value);

  const eventType = requiredString(value, 'eventType');
  if (!(DIRECT_MT5_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new Error(`eventType is unsupported: ${eventType}`);
  }

  const sequence = value.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0) {
    throw new Error('sequence must be a positive safe integer');
  }

  return {
    protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
    eventId: requiredString(value, 'eventId'),
    connectorId: requiredString(value, 'connectorId'),
    brokerConnectionId: requiredString(value, 'brokerConnectionId'),
    accountLogin: requiredString(value, 'accountLogin'),
    brokerServer: requiredString(value, 'brokerServer'),
    eventType: eventType as DirectMt5EventType,
    sequence: sequence as number,
    occurredAt: requiredIsoTimestamp(value, 'occurredAt'),
    payload: requiredPayload(value),
  };
}
