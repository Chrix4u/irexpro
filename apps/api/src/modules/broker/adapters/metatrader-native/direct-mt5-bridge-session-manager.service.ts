import { Injectable } from '@nestjs/common';
import { DirectMt5CommandService } from '../../direct-mt5/direct-mt5-command.service';
import {
  Mt5BridgeAccountIdentity,
  Mt5BridgeCapabilities,
  Mt5BridgeEnvironment,
  Mt5BridgeMarginMode,
} from './mt5-bridge-protocol';
import { Mt5BridgeSessionRegistry } from './mt5-bridge-session-registry.service';
import { DirectMt5BridgeSession } from './direct-mt5-bridge-session';

export interface DirectMt5SessionHeartbeat {
  connectorId: string;
  brokerConnectionId: string;
  accountLogin: string;
  brokerServer: string;
  company: string;
  environment: Mt5BridgeEnvironment;
  currency: string;
  leverage: number;
  marginMode: Mt5BridgeMarginMode;
  terminalConnected: boolean;
  terminalTradeAllowed: boolean;
  accountTradeAllowed: boolean;
  eaTradingAllowed: boolean;
  observedAt: Date;
}

@Injectable()
export class DirectMt5BridgeSessionManager {
  private readonly managed = new Map<string, DirectMt5BridgeSession>();

  constructor(
    private readonly registry: Mt5BridgeSessionRegistry,
    private readonly commands: DirectMt5CommandService,
  ) {}

  synchronize(input: DirectMt5SessionHeartbeat): void {
    if (input.environment !== 'DEMO') {
      throw new Error('Native MT5 bridge session is DEMO-only until LIVE certification completes');
    }
    if (!input.accountLogin.trim() || !input.brokerServer.trim()) {
      throw new Error('Native MT5 bridge session requires account login and broker server');
    }
    if (!Number.isSafeInteger(input.leverage) || input.leverage <= 0) {
      throw new Error('Native MT5 bridge session requires positive leverage');
    }

    const identity: Mt5BridgeAccountIdentity = {
      accountLogin: input.accountLogin,
      server: input.brokerServer,
      company: input.company,
      environment: input.environment,
      currency: input.currency,
      leverage: input.leverage,
      marginMode: input.marginMode,
    };
    const capabilities: Mt5BridgeCapabilities = {
      terminalConnected: input.terminalConnected,
      terminalTradeAllowed: input.terminalTradeAllowed,
      accountTradeAllowed: input.accountTradeAllowed,
      eaTradingAllowed: input.eaTradingAllowed,
    };

    const current = this.managed.get(input.brokerConnectionId);
    if (current?.sessionId === input.connectorId) {
      current.refresh({ identity, capabilities, lastHeartbeatAt: input.observedAt });
      return;
    }

    const health = this.registry.health(input.brokerConnectionId);
    if (health.sessionId) {
      this.registry.detach(input.brokerConnectionId, health.sessionId);
    }
    this.managed.delete(input.brokerConnectionId);

    const session = new DirectMt5BridgeSession({
      connectorId: input.connectorId,
      brokerConnectionId: input.brokerConnectionId,
      identity,
      capabilities,
      lastHeartbeatAt: input.observedAt,
      commands: this.commands,
    });
    this.registry.attach(input.brokerConnectionId, session);
    this.managed.set(input.brokerConnectionId, session);
  }

  detach(brokerConnectionId: string, connectorId: string): boolean {
    const detached = this.registry.detach(brokerConnectionId, connectorId);
    const managed = this.managed.get(brokerConnectionId);
    if (managed?.sessionId === connectorId) this.managed.delete(brokerConnectionId);
    return detached;
  }
}
