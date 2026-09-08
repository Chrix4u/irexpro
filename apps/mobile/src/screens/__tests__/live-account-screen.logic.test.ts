/**
 * LiveAccountScreen logic tests (Directive §J — §36 banner + §38 alerts).
 */
import type {
  LiveAccountEnvironment,
  LiveAccountOverviewView,
} from "@irexpro/types";
import {
  alertSeverityColor,
  environmentBanner,
  pnlSignClass,
  sortAlerts,
  summaryTiles,
} from "../live-account-screen.logic";

describe("environmentBanner (§36 — distinct, never ambiguous)", () => {
  it("gives PAPER, DEMO, LIVE and UNKNOWN distinct color triples", () => {
    const paper = environmentBanner("PAPER");
    const demo = environmentBanner("DEMO");
    const live = environmentBanner("LIVE");
    const unknown = environmentBanner("UNKNOWN");
    expect(paper.borderColor).not.toBe(demo.borderColor);
    expect(demo.borderColor).not.toBe(live.borderColor);
    expect(live.label).toBe("LIVE TRADING");
    expect(live.textColor).not.toBe(paper.textColor);
    // UNKNOWN is its own cautionary treatment — never PAPER's teal triple.
    expect(unknown.label).toBe("UNKNOWN");
    expect(unknown.borderColor).not.toBe(paper.borderColor);
    expect(unknown.backgroundColor).not.toBe(paper.backgroundColor);
    expect(unknown.textColor).not.toBe(paper.textColor);
  });

  it("falls back to UNKNOWN styling for unrecognized runtime values (never PAPER)", () => {
    // Runtime values from a contract-violating payload bypass the TS union —
    // the fallback must be the UNKNOWN banner, never a silent PAPER claim
    // (Phase F fail-closed provenance).
    const banner = environmentBanner("MYSTERY" as LiveAccountEnvironment);
    expect(banner.label).toBe("UNKNOWN");
    expect(banner.borderColor).toBe("#92400e");
    expect(banner.backgroundColor).not.toBe("#ccfbf1");
  });
});

describe("sortAlerts (worst-first)", () => {
  it("orders CRITICAL before WARNING before INFO", () => {
    const sorted = sortAlerts([
      {
        severity: "INFO",
        kind: "ACCOUNT_SYNC_STALE",
        key: "a",
        connectionId: null,
        brokerName: null,
        message: "m",
        action: null,
      },
      {
        severity: "CRITICAL",
        kind: "KILL_SWITCH_ACTIVE",
        key: "b",
        connectionId: null,
        brokerName: null,
        message: "m",
        action: null,
      },
      {
        severity: "WARNING",
        kind: "AUTOMATION_SUSPENDED",
        key: "c",
        connectionId: null,
        brokerName: null,
        message: "m",
        action: null,
      },
    ]);
    expect(sorted.map((a) => a.severity)).toEqual([
      "CRITICAL",
      "WARNING",
      "INFO",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [
      {
        severity: "INFO" as const,
        kind: "ACCOUNT_SYNC_STALE" as const,
        key: "a",
        connectionId: null,
        brokerName: null,
        message: "m",
        action: null,
      },
      {
        severity: "CRITICAL" as const,
        kind: "KILL_SWITCH_ACTIVE" as const,
        key: "b",
        connectionId: null,
        brokerName: null,
        message: "m",
        action: null,
      },
    ];
    sortAlerts(input);
    expect(input[0].severity).toBe("INFO");
  });
});

describe("alertSeverityColor", () => {
  it("maps severities to distinct colors", () => {
    expect(alertSeverityColor("CRITICAL")).not.toBe(
      alertSeverityColor("WARNING"),
    );
    expect(alertSeverityColor("WARNING")).not.toBe(alertSeverityColor("INFO"));
  });
});

describe("pnlSignClass (decimal-string only — never floats)", () => {
  it("classes by sign without numeric parsing", () => {
    expect(pnlSignClass("-12.34")).toBe("negative");
    expect(pnlSignClass("12.34")).toBe("positive");
    expect(pnlSignClass("0")).toBe("neutral");
    expect(pnlSignClass("")).toBe("neutral");
    expect(pnlSignClass(null)).toBe("neutral");
    expect(pnlSignClass(undefined)).toBe("neutral");
  });
});

describe("summaryTiles (§38 derived tiles)", () => {
  it("counts connections, positions, orders, and alert severities", () => {
    const overview = {
      generatedAt: "2026-02-01T12:00:00Z",
      connections: [{ id: "c1" }, { id: "c2" }],
      automation: {
        status: "ACTIVE",
        sessionId: null,
        sessionConnectionId: null,
        killSwitchActive: false,
        killSwitchReason: null,
        startedAt: null,
        endedAt: null,
      },
      executionHealth: {
        openPositions: 3,
        workingOrders: 2,
        reconciliationPending: 1,
        rejectedLast24h: 0,
        filledLast24h: 5,
      },
      alerts: [
        {
          severity: "CRITICAL",
          kind: "KILL_SWITCH_ACTIVE",
          key: "a",
          connectionId: null,
          brokerName: null,
          message: "m",
          action: null,
        },
        {
          severity: "CRITICAL",
          kind: "RECONCILIATION_DISCREPANCIES",
          key: "b",
          connectionId: null,
          brokerName: null,
          message: "m",
          action: null,
        },
        {
          severity: "WARNING",
          kind: "ACCOUNT_SYNC_STALE",
          key: "c",
          connectionId: null,
          brokerName: null,
          message: "m",
          action: null,
        },
      ],
      environment: "LIVE" as const,
      hasConnections: true,
    } as unknown as LiveAccountOverviewView;

    const tiles = summaryTiles(overview);
    expect(tiles.connectionsCount).toBe(2);
    expect(tiles.openPositions).toBe(3);
    expect(tiles.workingOrders).toBe(2);
    expect(tiles.reconciliationPending).toBe(1);
    expect(tiles.criticalAlerts).toBe(2);
    expect(tiles.warningAlerts).toBe(1);
  });
});
