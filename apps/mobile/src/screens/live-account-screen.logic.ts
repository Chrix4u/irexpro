/**
 * LiveAccountScreen pure presentation logic (Directive §36/§38).
 *
 * Environment banner classing, alert severity ordering, and P/L sign
 * classing — extracted as pure functions for unit testing (Directive §J).
 * All monetary values remain decimal STRINGS end-to-end (never parsed to
 * floats) — the API boundary contract.
 */
import type {
  LiveAccountAlertSeverity,
  LiveAccountAlertView,
  LiveAccountEnvironment,
  LiveAccountOverviewView,
} from "@irexpro/types";
import type { TradingSessionView } from "@irexpro/types/execution";

export interface EnvironmentBannerStyle {
  label: string;
  borderColor: string;
  backgroundColor: string;
  textColor: string;
}

const BANNERS: Record<LiveAccountEnvironment, EnvironmentBannerStyle> = {
  PAPER: {
    label: "PAPER",
    borderColor: "#0d9488",
    backgroundColor: "#ccfbf1",
    textColor: "#134e4a",
  },
  DEMO: {
    label: "DEMO",
    borderColor: "#f59e0b",
    backgroundColor: "#fef3c7",
    textColor: "#78350f",
  },
  LIVE: {
    label: "LIVE TRADING",
    borderColor: "#e11d48",
    backgroundColor: "#ffe4e6",
    textColor: "#881337",
  },
  /**
   * UNKNOWN (Phase F) — environment provenance could not be established.
   * Cautionary deep-amber/orange treatment, visually distinct from PAPER's
   * teal: an unproven environment is NEVER styled as the safe paper mode.
   */
  UNKNOWN: {
    label: "UNKNOWN",
    borderColor: "#92400e",
    backgroundColor: "#ffedd5",
    textColor: "#7c2d12",
  },
};

/**
 * §36 — visually distinct, never-ambiguous environment banner class.
 * Unrecognized RUNTIME values (contract violation) fall back to the UNKNOWN
 * banner — never to PAPER styling (fail-closed, Phase F).
 */
export function environmentBanner(
  environment: LiveAccountEnvironment,
): EnvironmentBannerStyle {
  return BANNERS[environment] ?? BANNERS.UNKNOWN;
}

const SEVERITY_ORDER: Record<LiveAccountAlertSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

/** Sort alerts worst-first (CRITICAL → WARNING → INFO). */
export function sortAlerts(
  alerts: LiveAccountAlertView[],
): LiveAccountAlertView[] {
  return [...alerts].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
  );
}

/** Alert badge color by severity. */
export function alertSeverityColor(severity: LiveAccountAlertSeverity): string {
  switch (severity) {
    case "CRITICAL":
      return "#e11d48";
    case "WARNING":
      return "#f59e0b";
    case "INFO":
      return "#0d9488";
    default:
      return "#6b7280";
  }
}

/** P/L sign classing from a decimal-string value (sign-aware, no float math). */
export function pnlSignClass(
  decimalString: string | null | undefined,
): "positive" | "negative" | "neutral" {
  const value = (decimalString ?? "").trim();
  if (value.startsWith("-")) return "negative";
  if (value.length === 0 || value === "0") return "neutral";
  return "positive";
}

export interface LiveAccountSummaryTiles {
  connectionsCount: number;
  openPositions: number;
  workingOrders: number;
  reconciliationPending: number;
  criticalAlerts: number;
  warningAlerts: number;
}

/** Derive the summary tile values from the overview payload (§38). */
export function summaryTiles(
  overview: LiveAccountOverviewView,
): LiveAccountSummaryTiles {
  const sorted = sortAlerts(overview.alerts);
  return {
    connectionsCount: overview.connections.length,
    openPositions: overview.executionHealth.openPositions,
    workingOrders: overview.executionHealth.workingOrders,
    reconciliationPending: overview.executionHealth.reconciliationPending,
    criticalAlerts: sorted.filter((a) => a.severity === "CRITICAL").length,
    warningAlerts: sorted.filter((a) => a.severity === "WARNING").length,
  };
}

// ── Trading session authority (Sprint 56 correction round 5) ────────────────

export interface SessionAuthorityPresentation {
  /** Human label for the durable execution mode. */
  modeLabel: string;
  /** Human label for the session lifecycle status. */
  statusLabel: string;
  /** True only when the server-reported session state blocks execution. */
  executionBlocked: boolean;
  /** Server-state-fed reasons (rendered verbatim; never speculated). */
  blockedReasons: string[];
}

/** Human label for a durable execution mode (mirrors the web workspace copy). */
export function executionModeLabel(mode: TradingSessionView["executionMode"]): string {
  switch (mode) {
    case "PAPER_ONLY":
      return "Paper only";
    case "SEMI_AUTO":
      return "Semi-auto (confirm each order)";
    case "FULL_AUTO":
      return "Full auto";
    default:
      return mode;
  }
}

/** Human label for a session lifecycle status. */
export function sessionStatusLabel(status: TradingSessionView["status"]): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "PAUSED":
      return "Paused";
    case "SUSPENDED_RISK_LIMIT":
      return "Suspended — risk limit";
    case "SUSPENDED_BROKER":
      return "Suspended — broker";
    case "ENDED":
      return "Ended";
    default:
      return status;
  }
}

/**
 * Session authority presentation (fail-closed): the mode/status/generation
 * are the AUTHORITATIVE trading state — `liveTradingEnabled` is only a
 * compatibility mirror and is never presented here. Blocked reasons come
 * solely from the server-reported session state.
 */
export function sessionAuthorityPresentation(
  session: TradingSessionView | null,
): SessionAuthorityPresentation {
  if (!session) {
    return {
      modeLabel: "Not started",
      statusLabel: "No active session",
      executionBlocked: true,
      blockedReasons: [
        "No active trading session — execution authority is not started. Start or manage sessions from the web workspace.",
      ],
    };
  }
  const blockedReasons: string[] = [];
  if (session.status === "ENDED") {
    blockedReasons.push("The trading session has ended.");
  } else if (session.status === "PAUSED") {
    blockedReasons.push("The trading session is paused.");
  } else if (session.status === "SUSPENDED_RISK_LIMIT") {
    blockedReasons.push("The trading session is suspended by a risk limit.");
  } else if (session.status === "SUSPENDED_BROKER") {
    blockedReasons.push("The trading session is suspended by the broker.");
  }
  return {
    modeLabel: executionModeLabel(session.executionMode),
    statusLabel: sessionStatusLabel(session.status),
    executionBlocked: session.status !== "ACTIVE",
    blockedReasons,
  };
}
