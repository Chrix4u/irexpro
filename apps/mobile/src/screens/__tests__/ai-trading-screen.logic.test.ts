import type { BrokerConnectionView } from "@irexpro/types";
import type {
  StopTradingSessionResponse,
  TradingSessionView,
} from "@irexpro/types/execution";
import {
  describeStopSummary,
  extractForexMarketSchedule,
  formatMarketReopenCountdown,
  isAutomationRunning,
  isBrokerExecutionReady,
  isWeekendMarketClosed,
  pinnedBrokerId,
  prepareBrokerForAutomationStart,
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

  it("prefers a connected broker over a remembered disconnected record", () => {
    const connections = [
      broker({ id: "broker-old", status: "DISCONNECTED", authorizationStatus: "DISCONNECTED" }),
      broker({ id: "broker-connected", status: "CONNECTED", authorizationStatus: "AUTHORIZED" }),
    ];
    expect(pinnedBrokerId(connections, null, "broker-old")).toBe(
      "broker-connected",
    );
  });

  it("prefers execution-ready ACTIVE authorization when several brokers are connected", () => {
    const connections = [
      broker({ id: "broker-connected", authorizationStatus: "AUTHORIZED" }),
      broker({ id: "broker-active", authorizationStatus: "ACTIVE" }),
    ];
    expect(pinnedBrokerId(connections, null, null)).toBe("broker-active");
  });

  it("requires ACTIVE authorization for LIVE external brokers", () => {
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "LIVE", authorizationStatus: "ACTIVE" }),
      ),
    ).toBe(true);
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "LIVE", authorizationStatus: "READY" }),
      ),
    ).toBe(false);
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "LIVE", status: "DISCONNECTED" }),
      ),
    ).toBe(false);
  });

  it("accepts a CONNECTED internal paper broker without external ACTIVE authorization", () => {
    expect(
      isBrokerExecutionReady(
        broker({
          brokerId: "paper-broker",
          status: "CONNECTED",
          authorizationStatus: "AUTHORIZED",
        }),
      ),
    ).toBe(true);
    expect(
      isBrokerExecutionReady(
        broker({
          brokerId: "paper-broker",
          status: "DISCONNECTED",
          authorizationStatus: "AUTHORIZED",
        }),
      ),
    ).toBe(false);
  });

  it("shows the closed-market replacement only for an authoritative weekend pause", () => {
    const weekend = extractForexMarketSchedule({
      marketSchedule: {
        paused: true,
        reason: "WEEKEND",
        nextEligibleScanAt: "2026-10-18T21:00:00.000Z",
      },
    });
    expect(weekend).not.toBeNull();
    expect(isWeekendMarketClosed(weekend)).toBe(true);
    expect(
      formatMarketReopenCountdown(weekend, Date.parse("2026-10-18T19:30:00.000Z")),
    ).toBe("1h 30m 00s");

    expect(
      isWeekendMarketClosed({
        paused: true,
        reason: "ROLLOVER_LOW_LIQUIDITY",
        nextEligibleScanAt: "2026-10-18T21:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isWeekendMarketClosed({
        paused: false,
        reason: null,
        nextEligibleScanAt: "2026-10-18T21:00:00.000Z",
      }),
    ).toBe(false);
    expect(extractForexMarketSchedule({ marketSchedule: { paused: true } })).toBeNull();
  });

  it("treats authorized external DEMO as preparable while LIVE still requires ACTIVE", () => {
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "DEMO", authorizationStatus: "AUTHORIZED" }),
      ),
    ).toBe(true);
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "DEMO", authorizationStatus: "READY" }),
      ),
    ).toBe(true);
    expect(
      isBrokerExecutionReady(
        broker({ accountType: "LIVE", authorizationStatus: "READY" }),
      ),
    ).toBe(false);
  });

  it("validates and enables an unvalidated external DEMO before automation start", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        overall: "PASS",
        demoValidated: true,
        steps: [{ name: "market-order", status: "PASS" }],
      })
      .mockResolvedValueOnce(undefined);

    await expect(
      prepareBrokerForAutomationStart(
        broker({
          accountType: "DEMO",
          authorizationStatus: "AUTHORIZED",
          demoValidated: false,
        }),
        request,
      ),
    ).resolves.toEqual({ ready: true });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/broker/connections/broker-1/validate-demo",
      { method: "POST" },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/broker/connections/broker-1/enable-demo-trading",
      { method: "POST" },
    );
  });

  it("does not enable a DEMO account when server validation fails", async () => {
    const request = jest.fn().mockResolvedValueOnce({
      overall: "FAIL",
      demoValidated: false,
      steps: [{ name: "market-order", status: "FAIL", detail: "order rejected" }],
    });

    await expect(
      prepareBrokerForAutomationStart(
        broker({
          accountType: "DEMO",
          authorizationStatus: "AUTHORIZED",
          demoValidated: false,
        }),
        request,
      ),
    ).resolves.toEqual({
      ready: false,
      message: "DEMO validation failed at market-order: order rejected",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps only the internal paper broker in PAPER_ONLY mode", () => {
    expect(
      startExecutionModeFor(
        broker({ brokerId: "paper-broker", accountType: "DEMO" }),
      ),
    ).toBe("PAPER_ONLY");
    expect(
      startExecutionModeFor(
        broker({ brokerId: "metatrader5", accountType: "DEMO" }),
      ),
    ).toBe("FULL_AUTO");
    expect(
      startExecutionModeFor(
        broker({ brokerId: "metatrader5", accountType: "LIVE" }),
      ),
    ).toBe("FULL_AUTO");
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
