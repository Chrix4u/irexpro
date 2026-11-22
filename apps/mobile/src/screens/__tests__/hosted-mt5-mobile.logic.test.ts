import type {
  BrokerRegistryEntry,
  DirectMt5ConnectionHealthView,
} from "@irexpro/types";
import {
  buildHostedMt5MobileRequest,
  hostedMt5MobileAvailability,
  hostedMt5MobileStatus,
} from "../hosted-mt5-mobile.logic";

const mt5 = (changes: Partial<BrokerRegistryEntry> = {}): BrokerRegistryEntry => ({
  id: "direct-mt5",
  name: "Direct MetaTrader 5",
  description: "MT5 hosted worker",
  status: "BETA",
  connectionRoutes: ["METATRADER"],
  capabilities: ["DEMO", "ACCOUNT_READ", "ORDER_PLACEMENT"],
  authenticationType: "SESSION_AUTH",
  environments: ["DEMO", "LIVE"],
  regions: [],
  adapterAvailable: true,
  hostedMt5Readiness: { ready: true, code: "READY", message: null },
  connectionReadiness: { ready: true, code: "READY", message: null },
  ...changes,
});

const health = (
  changes: Partial<DirectMt5ConnectionHealthView> = {},
): DirectMt5ConnectionHealthView => ({
  connectorId: "connector-1",
  brokerConnectionId: "connection-1",
  hostMode: "IREXPRO_HOSTED",
  state: "ACTIVE",
  connected: true,
  executionReady: true,
  tradeAllowed: true,
  lastHeartbeatAt: "2026-11-22T15:00:00.000Z",
  heartbeatAgeMs: 3000,
  accountLogin: "12345678",
  brokerServer: "Broker-Demo",
  reason: "READY",
  ...changes,
});

describe("native mobile hosted MT5 readiness", () => {
  it("accepts only an explicitly ready iRexPro-hosted DEMO broker", () => {
    expect(hostedMt5MobileAvailability(mt5()).ready).toBe(true);
    expect(hostedMt5MobileAvailability(mt5({
      hostedMt5Readiness: undefined,
    })).ready).toBe(false);
    expect(hostedMt5MobileAvailability(mt5({
      hostedMt5Readiness: {
        ready: false, code: "HOSTED_MT5_NO_WORKER", message: "No Windows worker",
      },
    }))).toEqual({ ready: false, message: "No Windows worker" });
    expect(hostedMt5MobileAvailability(mt5({
      adapterAvailable: false,
    })).ready).toBe(false);
    expect(hostedMt5MobileAvailability(mt5({
      environments: ["LIVE"],
    })).ready).toBe(false);
    expect(hostedMt5MobileAvailability(mt5({
      connectionReadiness: {
        ready: false, code: "ADAPTER_UNAVAILABLE", message: "Mobile blocked",
      },
    })).ready).toBe(false);
    expect(hostedMt5MobileAvailability(mt5({
      id: "metatrader5",
    })).ready).toBe(false);
  });
});

describe("native mobile hosted MT5 request", () => {
  const valid = {
    accountLogin: " 12345678 ",
    brokerServer: " Broker-Demo-01 ",
    tradingPassword: "private-trading-password",
    displayName: " My MT5 demo ",
  };

  it("uses encrypted server credential creation with an explicit HOSTED DEMO route", () => {
    expect(buildHostedMt5MobileRequest(mt5(), valid)).toEqual({
      brokerId: "direct-mt5",
      accountType: "DEMO",
      accountId: "12345678",
      apiSecret: "private-trading-password",
      displayName: "My MT5 demo",
      additionalParams: {
        brokerServer: "Broker-Demo-01",
        connectionMethod: "IREXPRO_HOSTED",
      },
    });
  });

  it("rejects an offline worker before processing credentials", () => {
    const result = buildHostedMt5MobileRequest(mt5({
      hostedMt5Readiness: { ready: false, code: "HOSTED_MT5_NO_WORKER", message: "Offline" },
    }), valid);
    expect(result).toEqual({ error: "Offline" });
  });

  it.each(["12ab", "1 2", "", "9".repeat(21)])(
    "rejects invalid numeric login %s",
    (accountLogin) => {
      expect("error" in buildHostedMt5MobileRequest(mt5(), {
        ...valid, accountLogin,
      })).toBe(true);
    },
  );

  it.each(["", "Test\nInjected", "X".repeat(256)])(
    "rejects an invalid server name",
    (brokerServer) => {
      expect("error" in buildHostedMt5MobileRequest(mt5(), {
        ...valid, brokerServer,
      })).toBe(true);
    },
  );

  it("rejects missing trading password and excessive display name", () => {
    expect("error" in buildHostedMt5MobileRequest(mt5(), {
      ...valid, tradingPassword: " ",
    })).toBe(true);
    expect("error" in buildHostedMt5MobileRequest(mt5(), {
      ...valid, displayName: "A".repeat(101),
    })).toBe(true);
  });
});

describe("hosted execution status never inferred from a saved connection", () => {
  it("reports waiting until an actual heartbeat is verified", () => {
    expect(hostedMt5MobileStatus(null).tone).toBe("waiting");
    expect(hostedMt5MobileStatus(health({ lastHeartbeatAt: null })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ reason: "HEARTBEAT_STALE" })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ tradeAllowed: false })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ heartbeatAgeMs: null })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ heartbeatAgeMs: 15_001 })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ heartbeatAgeMs: -1 })).tone)
      .toBe("waiting");
    expect(hostedMt5MobileStatus(health({ connected: false })).tone)
      .toBe("waiting");
  });

  it("does not pretend a personal connector is hosted", () => {
    expect(hostedMt5MobileStatus(health({ hostMode: "PERSONAL_PC" })).tone)
      .toBe("offline");
    expect(hostedMt5MobileStatus(health({ state: "REVOKED" })).tone)
      .toBe("offline");
  });

  it("calls a broker-verified, fresh execution heartbeat ready but still requires trading risk gates", () => {
    const result = hostedMt5MobileStatus(health());
    expect(result.tone).toBe("ready");
    expect(result.detail).toContain("risk gates");
  });
});
