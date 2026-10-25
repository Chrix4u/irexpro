import {
  Mt5BridgeAccountIdentity,
  Mt5BridgeCapabilities,
  Mt5BridgeCommand,
  Mt5BridgeResponse,
  Mt5BridgeSession,
} from './mt5-bridge-protocol';

export type FakeMt5BridgeHandler = (
  command: Mt5BridgeCommand,
) => Promise<Mt5BridgeResponse> | Mt5BridgeResponse;

export class FakeMt5BridgeSession implements Mt5BridgeSession {
  readonly commands: Mt5BridgeCommand[] = [];
  readonly sessionId: string;
  readonly identity: Mt5BridgeAccountIdentity;
  readonly capabilities: Mt5BridgeCapabilities;
  lastHeartbeatAt: Date;

  private readonly handler: FakeMt5BridgeHandler;

  constructor(input: {
    sessionId: string;
    identity: Mt5BridgeAccountIdentity;
    handler: FakeMt5BridgeHandler;
    capabilities?: Partial<Mt5BridgeCapabilities>;
    lastHeartbeatAt?: Date;
  }) {
    this.sessionId = input.sessionId;
    this.identity = { ...input.identity };
    this.capabilities = {
      terminalConnected: true,
      terminalTradeAllowed: true,
      accountTradeAllowed: true,
      eaTradingAllowed: true,
      ...input.capabilities,
    };
    this.handler = input.handler;
    this.lastHeartbeatAt = input.lastHeartbeatAt ?? new Date();
  }

  heartbeat(at = new Date()): void {
    this.lastHeartbeatAt = at;
  }

  async request(command: Mt5BridgeCommand): Promise<Mt5BridgeResponse> {
    this.commands.push(structuredClone(command));
    return this.handler(command);
  }
}
