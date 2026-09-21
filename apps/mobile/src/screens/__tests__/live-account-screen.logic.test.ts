/**
 * LiveAccountScreen logic tests (Directive §J — §36 banner + §38 alerts).
 */
import type {
  LiveAccountConnectionView,
  LiveAccountEnvironment,
  LiveAccountOverviewView,
} from "@irexpro/types";
import {
  activityPresentation,
  aiExitActivityRows,
  alertSeverityColor,
  environmentBanner,
  marginTiles,
  pnlSignClass,
  reconciliationSummary,
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



describe("AI exit activity monitoring", () => {
  it("never overstates AI_EXIT_SIGNAL_EXECUTED as a confirmed closed position", () => {
    const presentation = activityPresentation("AI_EXIT_SIGNAL_EXECUTED");

    expect(presentation.isAiExit).toBe(true);
    expect(presentation.label).toBe("AI exit processed");
    expect(presentation.detail).toContain("Check Positions");
    expect(presentation.label.toLowerCase()).not.toContain("closed");
  });

  it("makes failed and ignored exit decisions visibly distinct", () => {
    const failed = activityPresentation("AI_EXIT_SIGNAL_FAILED");
    const ignored = activityPresentation("AI_EXIT_SIGNAL_IGNORED");

    expect(failed.tone).toBe("danger");
    expect(failed.detail).toContain("may still be open");
    expect(ignored.tone).toBe("warning");
  });

  it("filters only AI exit rows and orders them newest first", () => {
    const rows = [
      {
        id: "a",
        action: "AI_EXIT_SIGNAL_RECEIVED",
        resourceType: "AiSignal",
        resourceId: "sig-1",
        severity: "INFO" as const,
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      {
        id: "b",
        action: "TRADE_OPENED",
        resourceType: "Trade",
        resourceId: "trade-1",
        severity: "INFO" as const,
        createdAt: "2026-09-18T11:00:00.000Z",
      },
      {
        id: "c",
        action: "AI_EXIT_SIGNAL_EXECUTED",
        resourceType: "AiSignal",
        resourceId: "sig-1",
        severity: "INFO" as const,
        createdAt: "2026-09-18T12:00:00.000Z",
      },
    ];

    expect(aiExitActivityRows(rows).map((row) => row.id)).toEqual(["c", "a"]);
  });

  it("provides readable fallback copy for unknown audit actions", () => {
    const presentation = activityPresentation("SOME_NEW_SERVER_ACTION");

    expect(presentation.label).toBe("Some New Server Action");
    expect(presentation.isAiExit).toBe(false);
  });
});

// ── Sprint 56 correction round 5: trading session authority ──────────────────

import type { TradingSessionView } from "@irexpro/types/execution";
import {
  executionModeLabel,
  sessionAuthorityPresentation,
  sessionStatusLabel,
} from "../live-account-screen.logic";

const session = (
  overrides: Partial<TradingSessionView>,
): TradingSessionView => ({
  id: "sess_00000000-0000-0000-0000-000000000001",
  brokerConnectionId: "bconn_00000000-0000-0000-0000-000000000001",
  executionMode: "SEMI_AUTO",
  authorityGeneration: 3,
  status: "ACTIVE",
  startedAt: "2026-09-10T00:00:00.000Z",
  ...overrides,
});

describe("sessionAuthorityPresentation (authoritative session state)", () => {
  it("an ACTIVE SEMI_AUTO session is not blocked and labels the mode honestly", () => {
    const presentation = sessionAuthorityPresentation(session({}));

    expect(presentation.modeLabel).toBe("Semi-auto (confirm each order)");
    expect(presentation.statusLabel).toBe("Active");
    expect(presentation.executionBlocked).toBe(false);
    expect(presentation.blockedReasons).toEqual([]);
  });

  it("a SUSPENDED_RISK_LIMIT session blocks execution with the server state as the reason", () => {
    const presentation = sessionAuthorityPresentation(
      session({ status: "SUSPENDED_RISK_LIMIT" }),
    );

    expect(presentation.executionBlocked).toBe(true);
    expect(presentation.statusLabel).toBe("Suspended — risk limit");
    expect(presentation.blockedReasons).toEqual([
      "The trading session is suspended by a risk limit.",
    ]);
  });

  it("no session at all reports execution authority not started (never inferred)", () => {
    const presentation = sessionAuthorityPresentation(null);

    expect(presentation.modeLabel).toBe("Not started");
    expect(presentation.statusLabel).toBe("No active session");
    expect(presentation.executionBlocked).toBe(true);
    expect(presentation.blockedReasons[0]).toContain(
      "No active trading session",
    );
  });

  it("labels every durable mode + lifecycle status humanly", () => {
    expect(executionModeLabel("PAPER_ONLY")).toBe("Paper only");
    expect(executionModeLabel("FULL_AUTO")).toBe("Full auto");
    expect(sessionStatusLabel("ENDED")).toBe("Ended");
    expect(sessionStatusLabel("PAUSED")).toBe("Paused");
    expect(sessionStatusLabel("SUSPENDED_BROKER")).toBe("Suspended — broker");
  });
});

describe("marginTiles (broker financial summary — never fabricated)", () => {
  const overviewWith = (financial: unknown): LiveAccountOverviewView =>
    ({
      generatedAt: "2026-09-01T12:00:00.000Z",
      connections: [
        {
          id: "bconn-1",
          reconciliation: {
            lastRunAt: null,
            lastRunStatus: null,
            openDiscrepancies: 0,
            openCritical: 0,
            openWarning: 0,
            inSync: true,
          },
          financial,
        },
      ],
      automation: {
        status: "IDLE",
        sessionId: null,
        sessionConnectionId: null,
        killSwitchActive: false,
        killSwitchReason: null,
        startedAt: null,
        endedAt: null,
      },
      executionHealth: {
        openPositions: 0,
        workingOrders: 0,
        reconciliationPending: 0,
        rejectedLast24h: 0,
        filledLast24h: 0,
      },
      alerts: [],
      environment: "UNKNOWN",
      hasConnections: true,
    }) as unknown as LiveAccountOverviewView;

  it("exposes margin / freeMargin / marginLevel from the primary connection", () => {
    const tiles = marginTiles(
      overviewWith({
        currency: "USD",
        balance: "10432.50",
        equity: "10501.23",
        margin: "412.00",
        freeMargin: "10089.23",
        marginLevel: "2551.26",
        openPositionsCount: 3,
        syncedAt: "2026-09-01T11:58:00.000Z",
      }),
    );

    expect(tiles.available).toBe(true);
    expect(tiles.currency).toBe("USD");
    expect(tiles.margin).toBe("412.00");
    expect(tiles.freeMargin).toBe("10089.23");
    expect(tiles.marginLevel).toBe("2551.26");
  });

  it("renders honest em-dashes when no financial snapshot exists (never a zero)", () => {
    const tiles = marginTiles(overviewWith(null));

    expect(tiles.available).toBe(false);
    expect(tiles.margin).toBe("—");
    expect(tiles.freeMargin).toBe("—");
    expect(tiles.marginLevel).toBeNull();
  });

  it("keeps a null marginLevel null (no margin in use is not a fabricated level)", () => {
    const tiles = marginTiles(
      overviewWith({
        currency: "EUR",
        balance: "1000.00",
        equity: "1000.00",
        margin: "0.00",
        freeMargin: "1000.00",
        marginLevel: null,
        openPositionsCount: 0,
        syncedAt: null,
      }),
    );

    expect(tiles.available).toBe(true);
    expect(tiles.marginLevel).toBeNull();
  });
});

describe("reconciliationSummary (fail-closed per-connection truth)", () => {
  const connection = (reconciliation: unknown) =>
    ({ reconciliation }) as Pick<LiveAccountConnectionView, "reconciliation">;

  it("renders the degraded unavailable state when reconciliationLoaded is false", () => {
    const view = reconciliationSummary(
      connection({
        lastRunAt: "2026-09-01T12:00:00.000Z",
        lastRunStatus: "COMPLETED",
        openDiscrepancies: 0,
        openCritical: 0,
        openWarning: 0,
        inSync: true,
      }),
      false,
    );

    expect(view.unavailable).toBe(true);
    // Zero-valued counts must NEVER be presented as "no open discrepancies".
    expect(view.discrepancyLabel).not.toContain("No open discrepancies");
    expect(view.discrepancyLabel).toContain("unavailable");
    expect(view.statusLabel).toBe("Unavailable");
    expect(view.inSync).toBe(false);
  });

  it("labels every lastRunStatus humanly with a matching tone", () => {
    const cases: Array<
      [LiveAccountConnectionView["reconciliation"]["lastRunStatus"], string, string]
    > = [
      ["COMPLETED", "Completed", "good"],
      ["COMPLETED_WITH_WARNINGS", "Completed with warnings", "warn"],
      ["FAILED", "Failed", "bad"],
      ["RUNNING", "Running now", "neutral"],
      ["PENDING", "Pending", "neutral"],
    ];
    for (const [status, label, tone] of cases) {
      const view = reconciliationSummary(
        connection({
          lastRunAt: "2026-09-01T12:00:00.000Z",
          lastRunStatus: status,
          openDiscrepancies: 0,
          openCritical: 0,
          openWarning: 0,
          inSync: true,
        }),
        true,
      );
      expect(view.statusLabel).toBe(label);
      expect(view.tone).toBe(tone);
    }
  });

  it("reports a never-run connection honestly (never 'in sync' history)", () => {
    const view = reconciliationSummary(
      connection({
        lastRunAt: null,
        lastRunStatus: null,
        openDiscrepancies: 0,
        openCritical: 0,
        openWarning: 0,
        inSync: true,
      }),
      undefined,
    );

    expect(view.statusLabel).toBe("Not yet reconciled");
    expect(view.lastRunLabel).toBe("Never run");
  });

  it("orders open discrepancy counts critical-first", () => {
    const view = reconciliationSummary(
      connection({
        lastRunAt: "2026-09-01T12:00:00.000Z",
        lastRunStatus: "FAILED",
        openDiscrepancies: 5,
        openCritical: 2,
        openWarning: 3,
        inSync: false,
      }),
      true,
    );

    expect(view.discrepancyLabel).toBe("2 critical · 3 warning · 5 open");
    expect(view.inSync).toBe(false);
    expect(view.tone).toBe("bad");
  });
});
