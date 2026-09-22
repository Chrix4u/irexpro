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

// ── October UAT hardening — WS1: manual single-position close ───────────────

import type { ManualPositionCloseOutcome } from "@irexpro/types/execution";
import type { LiveReadinessView } from "@irexpro/types";
import {
  manualCloseConfirmationMessage,
  manualClosePresentation,
  readinessBlockerRows,
  readinessDisplayRows,
} from "../live-account-screen.logic";

describe("manualClosePresentation (WS1 — honest outcome mapping)", () => {
  it("CLOSED renders as success with the server message", () => {
    const presentation = manualClosePresentation(
      "CLOSED",
      "Close confirmed at 1.2345.",
    );

    expect(presentation.tone).toBe("success");
    expect(presentation.title).toBe("Position closed");
    expect(presentation.message).toContain("Close confirmed at 1.2345.");
  });

  it("ALREADY_CLOSED is an idempotent retry, never a fresh close claim", () => {
    const presentation = manualClosePresentation(
      "ALREADY_CLOSED",
      "The position was already closed.",
    );

    expect(presentation.tone).toBe("info");
    expect(presentation.title).toBe("Already closed");
    expect(presentation.message).toContain("already closed");
  });

  it("CLOSE_IN_PROGRESS reports the in-flight close honestly", () => {
    const presentation = manualClosePresentation(
      "CLOSE_IN_PROGRESS",
      "Another close attempt is already in flight.",
    );

    expect(presentation.tone).toBe("info");
    expect(presentation.title).toBe("Close already in flight");
    expect(presentation.message).toContain("already in flight");
  });

  it("RECONCILIATION_REQUIRED explains reconciliation ownership (never a fabricated close)", () => {
    const presentation = manualClosePresentation(
      "RECONCILIATION_REQUIRED",
      "The provider outcome is unresolved.",
    );

    expect(presentation.tone).toBe("warning");
    expect(presentation.title).toBe("Provider confirmation pending");
    expect(presentation.message).toContain(
      "Provider confirmation pending — reconciliation will resolve the final state",
    );
    expect(presentation.message).toContain(
      "The provider outcome is unresolved.",
    );
  });

  it("PROVIDER_REFUSED is an error that keeps the server message and sanitized error class", () => {
    const presentation = manualClosePresentation(
      "PROVIDER_REFUSED",
      "The broker refused the close request.",
      "MARKET_CLOSED",
    );

    expect(presentation.tone).toBe("error");
    expect(presentation.title).toBe("Close refused");
    expect(presentation.message).toContain(
      "The broker refused the close request.",
    );
    expect(presentation.message).toContain("MARKET_CLOSED");
  });

  it("fails closed on an unrecognized runtime outcome (never a success claim)", () => {
    // A contract-violating runtime value bypasses the TS union — the mapping
    // must never render it as any of the positive outcomes.
    const presentation = manualClosePresentation(
      "MYSTERY" as ManualPositionCloseOutcome,
      "strange body",
    );

    expect(presentation.tone).toBe("error");
    expect(presentation.title).not.toBe("Position closed");
    expect(presentation.title).not.toBe("Already closed");
    expect(presentation.message).toContain("unrecognized");
  });

  it("keeps every outcome honest when the server message is empty", () => {
    const closed = manualClosePresentation("CLOSED", "  ");
    expect(closed.tone).toBe("success");
    expect(closed.message.length).toBeGreaterThan(0);
    expect(closed.message).toContain("Positions list");
  });
});

describe("manualCloseConfirmationMessage (WS1 — scoped confirmation copy)", () => {
  it("identifies the exact position and states the AI Trading scope boundary", () => {
    const message = manualCloseConfirmationMessage({
      instrument: "EURUSD",
      direction: "BUY",
      lotSize: "0.50",
    });

    expect(message).toContain("EURUSD BUY");
    expect(message).toContain("0.50 lots");
    expect(message).toContain(
      "This closes only this position. AI Trading and other positions are not affected.",
    );
  });
});

// ── October UAT hardening — WS5: separated trading readiness states ─────────

const readinessView = (
  overrides: Partial<LiveReadinessView> = {},
): LiveReadinessView => ({
  generatedAt: "2026-10-01T12:00:00.000Z",
  paper: { ready: false },
  demo: { verified: false },
  brokerLiveCertified: { certified: false, certifiedProviders: [] },
  model: {
    activeModelVersion: null,
    paperApproved: null,
    liveApproved: false,
    liveActivationReason: null,
  },
  liveTradingEnabled: { enabled: false },
  liveBlockers: [],
  ...overrides,
});

describe("readinessDisplayRows (WS5 — six separated states)", () => {
  it("renders all six positive states when every gate is genuinely satisfied", () => {
    const rows = readinessDisplayRows(
      readinessView({
        paper: { ready: true },
        demo: { verified: true },
        brokerLiveCertified: {
          certified: true,
          certifiedProviders: ["icmarkets"],
        },
        model: {
          activeModelVersion: "m-2026.10",
          paperApproved: true,
          liveApproved: true,
          liveActivationReason: null,
        },
        liveTradingEnabled: { enabled: true },
      }),
    );

    expect(rows.map((row) => row.statusText)).toEqual([
      "PAPER READY",
      "DEMO VERIFIED",
      "BROKER LIVE CERTIFIED",
      "MODEL PAPER APPROVED",
      "MODEL LIVE APPROVED",
      "LIVE TRADING ENABLED",
    ]);
    expect(rows.every((row) => row.met)).toBe(true);
  });

  it("renders the six negative states from an all-blocked view — never a bare 'Verified'", () => {
    const rows = readinessDisplayRows(readinessView());

    expect(rows.map((row) => row.statusText)).toEqual([
      "PAPER NOT READY",
      "DEMO NOT VALIDATED",
      "BROKER NOT LIVE CERTIFIED",
      "MODEL STATUS UNKNOWN",
      "MODEL NOT LIVE APPROVED",
      "LIVE TRADING NOT ENABLED",
    ]);
    expect(rows.every((row) => row.met)).toBe(false);
    for (const row of rows) {
      expect(row.statusText).not.toBe("Verified");
      expect(row.statusText.length).toBeGreaterThan(0);
    }
  });

  it("a null paperApproved renders MODEL STATUS UNKNOWN (honest, never approved)", () => {
    const rows = readinessDisplayRows(
      readinessView({
        model: {
          activeModelVersion: "m-1",
          paperApproved: null,
          liveApproved: false,
          liveActivationReason: "not promoted",
        },
      }),
    );
    const paperRow = rows.find((row) => row.key === "modelPaperApproved");

    expect(paperRow?.statusText).toBe("MODEL STATUS UNKNOWN");
    expect(paperRow?.met).toBe(false);
  });

  it("an explicit paperApproved=false renders MODEL NOT PAPER APPROVED", () => {
    const rows = readinessDisplayRows(
      readinessView({
        model: {
          activeModelVersion: "m-1",
          paperApproved: false,
          liveApproved: false,
          liveActivationReason: null,
        },
      }),
    );
    const paperRow = rows.find((row) => row.key === "modelPaperApproved");

    expect(paperRow?.statusText).toBe("MODEL NOT PAPER APPROVED");
    expect(paperRow?.met).toBe(false);
  });

  it("a DEMO verification NEVER renders as broker LIVE certification", () => {
    const rows = readinessDisplayRows(
      readinessView({ demo: { verified: true } }),
    );
    const brokerRow = rows.find((row) => row.key === "brokerLiveCertified");

    expect(brokerRow?.statusText).toBe("BROKER NOT LIVE CERTIFIED");
    expect(brokerRow?.met).toBe(false);
  });

  it("a certified broker NEVER implies the active model is LIVE-approved", () => {
    const rows = readinessDisplayRows(
      readinessView({
        brokerLiveCertified: {
          certified: true,
          certifiedProviders: ["icmarkets"],
        },
      }),
    );
    const modelRow = rows.find((row) => row.key === "modelLiveApproved");

    expect(modelRow?.statusText).toBe("MODEL NOT LIVE APPROVED");
    expect(modelRow?.met).toBe(false);
  });

  it("passes server-provided details through verbatim (model, providers, activation reason)", () => {
    const rows = readinessDisplayRows(
      readinessView({
        brokerLiveCertified: {
          certified: true,
          certifiedProviders: ["icmarkets", "pepperstone"],
        },
        model: {
          activeModelVersion: "v7",
          paperApproved: true,
          liveApproved: false,
          liveActivationReason: "No LIVE promotion record for v7.",
        },
      }),
    );

    expect(
      rows.find((row) => row.key === "modelPaperApproved")?.detail,
    ).toBe("Active model: v7");
    expect(rows.find((row) => row.key === "modelLiveApproved")?.detail).toBe(
      "No LIVE promotion record for v7.",
    );
    expect(
      rows.find((row) => row.key === "brokerLiveCertified")?.detail,
    ).toBe("Certified providers: icmarkets, pepperstone");
  });
});

describe("readinessBlockerRows (WS5 — verbatim server blocker passthrough)", () => {
  it("passes blocker messages through verbatim in server order", () => {
    const blockers = readinessBlockerRows(
      readinessView({
        liveBlockers: [
          {
            reasonCode: "NO_CERTIFIED_BROKER",
            message:
              "Real-money trading is unavailable because no broker has completed production-LIVE certification.",
          },
          {
            reasonCode: "MODEL_NOT_LIVE_APPROVED",
            message:
              "Real-money AI trading is unavailable because the active AI model (v7) has not received LIVE approval.",
          },
        ],
      }),
    );

    expect(blockers).toEqual([
      {
        reasonCode: "NO_CERTIFIED_BROKER",
        message:
          "Real-money trading is unavailable because no broker has completed production-LIVE certification.",
      },
      {
        reasonCode: "MODEL_NOT_LIVE_APPROVED",
        message:
          "Real-money AI trading is unavailable because the active AI model (v7) has not received LIVE approval.",
      },
    ]);
  });

  it("returns an empty list when the server reports no blockers", () => {
    expect(readinessBlockerRows(readinessView())).toEqual([]);
  });
});
