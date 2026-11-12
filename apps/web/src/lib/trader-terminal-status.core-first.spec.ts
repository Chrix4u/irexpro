import { api } from "@/lib/api";
import {
  loadLatestEndedTradingSession,
  loadTraderTerminalStatus,
} from "./trader-terminal-status";

jest.mock("@/lib/api", () => ({
  api: {
    request: jest.fn(),
    listBrokerConnections: jest.fn(),
  },
}));

const broker = {
  id: "00000000-0000-0000-0000-000000000099",
  brokerId: "pepperstone-ctrader",
  brokerName: "Pepperstone cTrader",
  accountType: "DEMO",
  status: "CONNECTED",
  authorizationStatus: "ACTIVE",
};

const risk = {
  killSwitchActive: false,
  brokerConnected: true,
  canTrade: true,
  limits: {
    maxDailyLossPercent: "3.00",
    maxDrawdownPercent: "12.00",
    positionCountPolicy: "UNBOUNDED",
    dailyTradeCountPolicy: "UNBOUNDED",
    maxPositionSizeLot: "1.00",
    allowedInstruments: ["EURUSD", "AUDUSD"],
    maxVolatilityScore: "1",
  },
};

describe("Core-first AI terminal loading", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (api.listBrokerConnections as jest.Mock).mockResolvedValue([broker]);
  });

  it("returns authoritative risk/session/broker without awaiting ended-session history", async () => {
    (api.request as jest.Mock).mockImplementation((path: string) => {
      if (path === "/risk/status") return Promise.resolve(risk);
      if (path === "/trading/sessions/active") return Promise.resolve(null);
      if (path === "/trading/sessions/latest-ended") return new Promise(() => {});
      throw Error("Unexpected path: " + path);
    });

    const result = await loadTraderTerminalStatus();
    expect(result.risk?.canTrade).toBe(true);
    expect(result.sessionStateKnown).toBe(true);
    expect(result.session).toBeNull();
    expect(result.primaryBroker?.brokerId).toBe("pepperstone-ctrader");
    expect(result.lastEndedSession).toBeNull();
    const paths = (api.request as jest.Mock).mock.calls.map(([path]) => path);
    expect(paths).not.toContain("/trading/sessions/latest-ended");
  });

  it("keeps the optional ended-session read independent and validated", async () => {
    (api.request as jest.Mock).mockResolvedValue({
      session: {
        id: "00000000-0000-0000-0000-000000000123",
        brokerConnectionId: broker.id,
        executionMode: "FULL_AUTO",
        status: "ENDED",
        authorityGeneration: 2,
        startedAt: "2026-11-12T10:00:00.000Z",
      },
    });
    const ended = await loadLatestEndedTradingSession();
    expect(ended?.status).toBe("ENDED");
    expect(ended?.brokerConnectionId).toBe(broker.id);
  });
});
