import type { BrokerConnectionView } from "@irexpro/types";
import type {
  StopTradingSessionResponse,
  TradingSessionView,
} from "@irexpro/types/execution";
import {
  describeStopSummary,
  isAutomationRunning,
  isBrokerExecutionReady,
  pinnedBrokerId,
  startExecutionModeFor,
} from "../ai-trading-screen.logic";

function broker(
  overrides: Partial<BrokerConnectionView> = {},
): BrokerConnectionView {
  return {
    id: "broker-1",
    userId: "user-1",
    brokerId: "provider-1",
    brokerName: "Demo Broker",
    displayName: "Primary",
    accountId: "acct-1",
    accountType: "DEMO",
    accountCurrency: "USD",
    accountLeverage: 100,
    status: "CONNECTED",
    authorizationStatus: "ACTIVE",
    credentialStatus: "VERIFIED",
    authorizedAt: "2026-09-18T00:00:00.000Z",
    authorizationRevokedAt: null,
    demoValidated: true,
    liveTradingEnabled: false,
    providerBrokerIdentity: null,
    logicalAccountKey: "provider:acct-1",
    lastHealthCheckAt: null,
    lastSyncAt: null,
    lastErrorMessage: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function session(
  overrides: Partial<TradingSessionView> = {},
): TradingSessionView {
  return {
    id: "session-1",
    brokerConnectionId: "broker-1",
    executionMode: "PAPER_ONLY",
    authorityGeneration: 1,
    status: "ACTIVE",
    startedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function stopResult(
  overrides: Partial<StopTradingSessionResponse["positionCloseSummary"]>,
): StopTradingSessionResponse {
  return {
    message: "stopped",
    sessionId: "session-1",
    positionCloseSummary: {
      state: "COMPLETE",
      targetCount: 0,
      closedCount: 0,
      unresolvedCount: 0,
      ...overrides,
    },
  };
}

describe("AI Trading mobile logic", () => {
  it("treats ACTIVE and PAUSED sessions as running authority", () => {
    expect(isAutomationRunning(session({ status: "ACTIVE" }))).toBe(true);
    expect(isAutomationRunning(session({ status: "PAUSED" }))).toBe(true);
    expect(isAutomationRunning(session({ status: "ENDED" }))).toBe(false);
    expect(isAutomationRunning(null)).toBe(false);
  });

  it("pins broker selection to the active session", () => {
    const connections = [
      broker({ id: "broker-1" }),
      broker({ id: "broker-2" }),
    ];
    expect(
      pinnedBrokerId(
        connections,
        session({ brokerConnectionId: "broker-2" }),
        "broker-1",
      ),
    ).toBe("broker-2");
    expect(pinnedBrokerId(connections, null, "broker-1")).toBe("broker-1");
  });

  it("requires both CONNECTED and ACTIVE authorization before start", () => {
    expect(isBrokerExecutionReady(broker())).toBe(true);
    expect(
      isBrokerExecutionReady(
        broker({ authorizationStatus: "READY" }),
      ),
    ).toBe(false);
    expect(
      isBrokerExecutionReady(broker({ status: "DISCONNECTED" })),
    ).toBe(false);
  });

  it("maps demo accounts to paper and live accounts to full auto", () => {
    expect(startExecutionModeFor(broker({ accountType: "DEMO" }))).toBe(
      "PAPER_ONLY",
    );
    expect(startExecutionModeFor(broker({ accountType: "LIVE" }))).toBe(
      "FULL_AUTO",
    );
  });

  it("never claims unresolved stop closures are complete", () => {
    const partial = describeStopSummary(
      stopResult({
        state: "PARTIAL",
        targetCount: 3,
        closedCount: 2,
        unresolvedCount: 1,
      }),
    );
    expect(partial.tone).toBe("warning");
    expect(partial.message).toContain("1 require follow-up");

    const unknown = describeStopSummary(
      stopResult({
        state: "UNKNOWN",
        targetCount: null,
        closedCount: 0,
        unresolvedCount: null,
      }),
    );
    expect(unknown.tone).toBe("warning");
    expect(unknown.message).toContain("could not be verified");
  });
});
