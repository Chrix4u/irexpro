export const MT5_BRIDGE_PROTOCOL_VERSION = 1 as const;

export type Mt5BridgeEnvironment = 'DEMO' | 'LIVE';
export type Mt5BridgeMarginMode = 'HEDGING' | 'NETTING' | 'EXCHANGE';

export interface Mt5BridgeAccountIdentity {
  accountLogin: string;
  server: string;
  company: string;
  environment: Mt5BridgeEnvironment;
  currency: string;
  leverage: number;
  marginMode: Mt5BridgeMarginMode;
}

export interface Mt5BridgeCapabilities {
  terminalConnected: boolean;
  terminalTradeAllowed: boolean;
  accountTradeAllowed: boolean;
  eaTradingAllowed: boolean;
  terminalBuild?: number;
  eaVersion?: string;
}

export type Mt5BridgeCommandName =
  | 'GET_ACCOUNT_INFO'
  | 'GET_SYMBOLS'
  | 'GET_TICK'
  | 'GET_RATES'
  | 'CALCULATE_MARGIN'
  | 'LIST_POSITIONS'
  | 'LIST_ORDERS'
  | 'GET_ORDER'
  | 'GET_HISTORY'
  | 'PLACE_ORDER'
  | 'MODIFY_ORDER'
  | 'CLOSE_POSITION'
  | 'CANCEL_ORDER'
  | 'CLOSE_IREXPRO_POSITIONS';

const MUTATING_COMMANDS = new Set<Mt5BridgeCommandName>([
  'PLACE_ORDER',
  'MODIFY_ORDER',
  'CLOSE_POSITION',
  'CANCEL_ORDER',
  'CLOSE_IREXPRO_POSITIONS',
]);

export interface Mt5BridgeOwnershipMarker {
  magicNumber: number;
  commentPrefix: string;
}

export interface Mt5BridgeCommand<TPayload = unknown> {
  protocolVersion: typeof MT5_BRIDGE_PROTOCOL_VERSION;
  type: 'COMMAND';
  sessionId: string;
  requestId: string;
  sequence: number;
  sentAt: string;
  nonce: string;
  commandName: Mt5BridgeCommandName;
  payload: TPayload;
  signature: string;
  idempotencyKey?: string;
  expiresAt?: string;
  expectedIdentity?: Mt5BridgeAccountIdentity;
  ownership?: Mt5BridgeOwnershipMarker;
}

export interface Mt5BridgeResponse<TPayload = unknown> {
  protocolVersion: typeof MT5_BRIDGE_PROTOCOL_VERSION;
  type: 'RESPONSE';
  sessionId: string;
  requestId: string;
  sequence: number;
  sentAt: string;
  nonce: string;
  ok: boolean;
  payload?: TPayload;
  error?: {
    code: string;
    message: string;
    certainty?: 'REJECTED' | 'UNCERTAIN' | 'KNOWN_NOT_SENT';
  };
}

export interface Mt5BridgeEvent<TPayload = unknown> {
  protocolVersion: typeof MT5_BRIDGE_PROTOCOL_VERSION;
  type: 'EVENT' | 'HEARTBEAT';
  sessionId: string;
  sequence: number;
  sentAt: string;
  nonce: string;
  eventName: string;
  payload: TPayload;
  signature: string;
}

export interface Mt5BridgeSession {
  readonly sessionId: string;
  readonly identity: Mt5BridgeAccountIdentity;
  readonly capabilities: Mt5BridgeCapabilities;
  lastHeartbeatAt: Date;
  request(command: Mt5BridgeCommand): Promise<Mt5BridgeResponse>;
}

export type Mt5BridgeProtocolErrorCode =
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'COMMAND_EXPIRED'
  | 'MUTATION_IDEMPOTENCY_REQUIRED'
  | 'MUTATION_OWNERSHIP_REQUIRED'
  | 'SEQUENCE_REPLAYED'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_COMMAND_ENVELOPE';

export class Mt5BridgeProtocolError extends Error {
  constructor(public readonly code: Mt5BridgeProtocolErrorCode) {
    super(code);
    this.name = 'Mt5BridgeProtocolError';
  }
}

export interface BuildMt5BridgeCommandInput<TPayload> {
  sessionId: string;
  requestId: string;
  sequence: number;
  nonce: string;
  commandName: Mt5BridgeCommandName;
  payload: TPayload;
  signature: string;
  sentAt?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  expectedIdentity?: Mt5BridgeAccountIdentity;
  ownership?: Mt5BridgeOwnershipMarker;
}

export function buildMt5BridgeCommand<TPayload>(
  input: BuildMt5BridgeCommandInput<TPayload>,
): Mt5BridgeCommand<TPayload> {
  return {
    protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
    type: 'COMMAND',
    sessionId: input.sessionId,
    requestId: input.requestId,
    sequence: input.sequence,
    sentAt: input.sentAt ?? new Date().toISOString(),
    nonce: input.nonce,
    commandName: input.commandName,
    payload: input.payload,
    signature: input.signature,
    idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt,
    expectedIdentity: input.expectedIdentity,
    ownership: input.ownership,
  };
}

export function isMt5BridgeMutation(commandName: Mt5BridgeCommandName): boolean {
  return MUTATING_COMMANDS.has(commandName);
}

export function sameMt5Identity(
  actual: Mt5BridgeAccountIdentity,
  expected: Mt5BridgeAccountIdentity,
): boolean {
  return (
    actual.accountLogin === expected.accountLogin &&
    actual.server === expected.server &&
    actual.environment === expected.environment
  );
}

export function validateMt5BridgeCommand(
  command: Mt5BridgeCommand,
  context: {
    now?: Date;
    expectedIdentity: Mt5BridgeAccountIdentity;
    lastSequence: number;
  },
): void {
  if (command.protocolVersion !== MT5_BRIDGE_PROTOCOL_VERSION) {
    throw new Mt5BridgeProtocolError('PROTOCOL_VERSION_UNSUPPORTED');
  }
  if (
    command.type !== 'COMMAND' ||
    !command.sessionId?.trim() ||
    !command.requestId?.trim() ||
    !command.nonce?.trim() ||
    !command.signature?.trim() ||
    !Number.isSafeInteger(command.sequence) ||
    command.sequence < 1
  ) {
    throw new Mt5BridgeProtocolError('INVALID_COMMAND_ENVELOPE');
  }
  if (command.sequence <= context.lastSequence) {
    throw new Mt5BridgeProtocolError('SEQUENCE_REPLAYED');
  }

  const sentAtMs = Date.parse(command.sentAt);
  if (!Number.isFinite(sentAtMs)) throw new Mt5BridgeProtocolError('INVALID_TIMESTAMP');

  if (isMt5BridgeMutation(command.commandName)) {
    if (!command.idempotencyKey?.trim()) {
      throw new Mt5BridgeProtocolError('MUTATION_IDEMPOTENCY_REQUIRED');
    }
    if (
      !command.ownership?.commentPrefix?.trim() ||
      !Number.isSafeInteger(command.ownership.magicNumber)
    ) {
      throw new Mt5BridgeProtocolError('MUTATION_OWNERSHIP_REQUIRED');
    }
    const expiresAtMs = Date.parse(command.expiresAt ?? '');
    if (!Number.isFinite(expiresAtMs)) throw new Mt5BridgeProtocolError('INVALID_TIMESTAMP');
    if (expiresAtMs <= (context.now ?? new Date()).getTime()) {
      throw new Mt5BridgeProtocolError('COMMAND_EXPIRED');
    }
    if (
      !command.expectedIdentity ||
      !sameMt5Identity(command.expectedIdentity, context.expectedIdentity)
    ) {
      throw new Mt5BridgeProtocolError('ACCOUNT_IDENTITY_MISMATCH');
    }
  }
}

const SECRET_KEY = /(signature|token|secret|credential|password)/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(nested);
  }
  return output;
}

export function sanitizeMt5BridgeEnvelopeForLog<T>(envelope: T): T {
  return sanitize(envelope) as T;
}
