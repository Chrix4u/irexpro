import { Injectable } from '@nestjs/common';
import {
  isMt5BridgeMutation,
  Mt5BridgeAccountIdentity,
  Mt5BridgeCommand,
  Mt5BridgeResponse,
  Mt5BridgeSession,
  sameMt5Identity,
  validateMt5BridgeCommand,
} from './mt5-bridge-protocol';

export type Mt5BridgeSessionRegistryErrorCode =
  | 'SESSION_ALREADY_ATTACHED'
  | 'ACCOUNT_ALREADY_BOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_STALE'
  | 'SESSION_IDENTITY_MISMATCH'
  | 'SESSION_TRADING_UNAVAILABLE'
  | 'COMMAND_SESSION_MISMATCH'
  | 'SESSION_REQUEST_TIMEOUT'
  | 'COMMAND_OUTCOME_UNCERTAIN'
  | 'SESSION_GENERATION_CHANGED'
  | 'INVALID_BRIDGE_RESPONSE';

export class Mt5BridgeSessionRegistryError extends Error {
  constructor(public readonly code: Mt5BridgeSessionRegistryErrorCode) {
    super(code);
    this.name = 'Mt5BridgeSessionRegistryError';
  }
}

interface AttachedSession {
  session: Mt5BridgeSession;
  boundIdentity: Mt5BridgeAccountIdentity;
  generation: number;
  lastSequence: number;
  accountKey: string;
}

export interface Mt5BridgeSessionHealth {
  state: 'DISCONNECTED' | 'HEALTHY' | 'STALE' | 'IDENTITY_MISMATCH' | 'TRADING_UNAVAILABLE';
  sessionId: string | null;
  accountLogin: string | null;
  server: string | null;
  environment: 'DEMO' | 'LIVE' | null;
  lastHeartbeatAt: string | null;
  generation: number | null;
}

@Injectable()
export class Mt5BridgeSessionRegistry {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly accountBindings = new Map<string, string>();
  private readonly generationCounters = new Map<string, number>();
  private readonly staleAfterMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: { staleAfterMs?: number; requestTimeoutMs?: number } = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  attach(connectionId: string, session: Mt5BridgeSession): number {
    if (this.sessions.has(connectionId)) {
      throw new Mt5BridgeSessionRegistryError('SESSION_ALREADY_ATTACHED');
    }
    const accountKey = this.accountKey(session.identity);
    const existingConnection = this.accountBindings.get(accountKey);
    if (existingConnection && existingConnection !== connectionId) {
      throw new Mt5BridgeSessionRegistryError('ACCOUNT_ALREADY_BOUND');
    }

    const generation = (this.generationCounters.get(connectionId) ?? 0) + 1;
    this.generationCounters.set(connectionId, generation);
    this.sessions.set(connectionId, {
      session,
      boundIdentity: { ...session.identity },
      generation,
      lastSequence: 0,
      accountKey,
    });
    this.accountBindings.set(accountKey, connectionId);
    return generation;
  }

  detach(connectionId: string, sessionId: string): boolean {
    const attached = this.sessions.get(connectionId);
    if (!attached || attached.session.sessionId !== sessionId) return false;
    this.sessions.delete(connectionId);
    if (this.accountBindings.get(attached.accountKey) === connectionId) {
      this.accountBindings.delete(attached.accountKey);
    }
    return true;
  }

  getHealthySession(
    connectionId: string,
    expectedIdentity?: Mt5BridgeAccountIdentity,
  ): Mt5BridgeSession {
    const attached = this.sessions.get(connectionId);
    if (!attached) throw new Mt5BridgeSessionRegistryError('SESSION_NOT_FOUND');

    if (!sameMt5Identity(attached.session.identity, attached.boundIdentity)) {
      throw new Mt5BridgeSessionRegistryError('SESSION_IDENTITY_MISMATCH');
    }
    if (expectedIdentity && !sameMt5Identity(attached.session.identity, expectedIdentity)) {
      throw new Mt5BridgeSessionRegistryError('SESSION_IDENTITY_MISMATCH');
    }
    if (Date.now() - attached.session.lastHeartbeatAt.getTime() > this.staleAfterMs) {
      throw new Mt5BridgeSessionRegistryError('SESSION_STALE');
    }
    const capabilities = attached.session.capabilities;
    if (
      !capabilities.terminalConnected ||
      !capabilities.terminalTradeAllowed ||
      !capabilities.accountTradeAllowed ||
      !capabilities.eaTradingAllowed
    ) {
      throw new Mt5BridgeSessionRegistryError('SESSION_TRADING_UNAVAILABLE');
    }
    return attached.session;
  }

  async request(connectionId: string, command: Mt5BridgeCommand): Promise<Mt5BridgeResponse> {
    const attached = this.sessions.get(connectionId);
    if (!attached) throw new Mt5BridgeSessionRegistryError('SESSION_NOT_FOUND');
    const session = this.getHealthySession(connectionId, attached.boundIdentity);
    if (command.sessionId !== session.sessionId) {
      throw new Mt5BridgeSessionRegistryError('COMMAND_SESSION_MISMATCH');
    }

    validateMt5BridgeCommand(command, {
      expectedIdentity: attached.boundIdentity,
      lastSequence: attached.lastSequence,
    });
    attached.lastSequence = command.sequence;
    const generationAtDispatch = attached.generation;

    let timeout: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Mt5BridgeSessionRegistryError(
              isMt5BridgeMutation(command.commandName)
                ? 'COMMAND_OUTCOME_UNCERTAIN'
                : 'SESSION_REQUEST_TIMEOUT',
            ),
          );
        }, this.requestTimeoutMs);
        timeout.unref?.();
      });
      const response = await Promise.race([session.request(command), timeoutPromise]);
      const current = this.sessions.get(connectionId);
      if (
        !current ||
        current.generation !== generationAtDispatch ||
        current.session.sessionId !== session.sessionId
      ) {
        throw new Mt5BridgeSessionRegistryError('SESSION_GENERATION_CHANGED');
      }
      if (
        response.sessionId !== session.sessionId ||
        response.requestId !== command.requestId ||
        response.protocolVersion !== command.protocolVersion
      ) {
        throw new Mt5BridgeSessionRegistryError('INVALID_BRIDGE_RESPONSE');
      }
      return response;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  health(connectionId: string): Mt5BridgeSessionHealth {
    const attached = this.sessions.get(connectionId);
    if (!attached) {
      return {
        state: 'DISCONNECTED',
        sessionId: null,
        accountLogin: null,
        server: null,
        environment: null,
        lastHeartbeatAt: null,
        generation: null,
      };
    }
    let state: Mt5BridgeSessionHealth['state'] = 'HEALTHY';
    if (!sameMt5Identity(attached.session.identity, attached.boundIdentity)) {
      state = 'IDENTITY_MISMATCH';
    } else if (Date.now() - attached.session.lastHeartbeatAt.getTime() > this.staleAfterMs) {
      state = 'STALE';
    } else if (
      !attached.session.capabilities.terminalConnected ||
      !attached.session.capabilities.terminalTradeAllowed ||
      !attached.session.capabilities.accountTradeAllowed ||
      !attached.session.capabilities.eaTradingAllowed
    ) {
      state = 'TRADING_UNAVAILABLE';
    }
    return {
      state,
      sessionId: attached.session.sessionId,
      accountLogin: attached.boundIdentity.accountLogin,
      server: attached.boundIdentity.server,
      environment: attached.boundIdentity.environment,
      lastHeartbeatAt: attached.session.lastHeartbeatAt.toISOString(),
      generation: attached.generation,
    };
  }

  private accountKey(identity: Mt5BridgeAccountIdentity): string {
    return `${identity.accountLogin.trim()}|${identity.server.trim().toLowerCase()}|${identity.environment}`;
  }
}
