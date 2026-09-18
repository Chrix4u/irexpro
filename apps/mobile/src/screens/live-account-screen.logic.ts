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
  LiveActivityRowView,
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



// ── Activity / AI exit monitoring ───────────────────────────────────────────

export interface ActivityPresentation {
  label: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "danger";
  isAiExit: boolean;
}

/**
 * User-facing copy for audit actions. The presentation never infers broker
 * execution beyond the server action. In particular, AI_EXIT_SIGNAL_EXECUTED
 * is rendered as "processed" rather than "closed" because the durable audit
 * metadata can represent a partial close; the Positions list remains the
 * authoritative current-open-state surface.
 */
export function activityPresentation(action: string): ActivityPresentation {
  switch (action) {
    case "AI_EXIT_SIGNAL_RECEIVED":
      return {
        label: "AI exit received",
        detail: "The AI submitted an exit decision for server processing.",
        tone: "neutral",
        isAiExit: true,
      };
    case "AI_EXIT_SIGNAL_EXECUTED":
      return {
        label: "AI exit processed",
        detail:
          "The server processed the AI exit request. Check Positions for the authoritative open-position state.",
        tone: "success",
        isAiExit: true,
      };
    case "AI_EXIT_SIGNAL_FAILED":
      return {
        label: "AI exit failed",
        detail:
          "The exit request did not complete successfully. The position may still be open; check Positions and alerts.",
        tone: "danger",
        isAiExit: true,
      };
    case "AI_EXIT_SIGNAL_IGNORED":
      return {
        label: "AI exit ignored",
        detail:
          "The server did not act on this exit decision, for example because it was stale, low confidence, or no open target remained.",
        tone: "warning",
        isAiExit: true,
      };
    case "TRADE_CLOSED":
      return {
        label: "Position closed",
        detail: "A trade reached the server's closed state.",
        tone: "success",
        isAiExit: false,
      };
    case "TRADE_OPENED":
      return {
        label: "Position opened",
        detail: "A trade reached the server's open state.",
        tone: "neutral",
        isAiExit: false,
      };
    case "ORDER_RECONCILIATION_PENDING":
      return {
        label: "Order needs reconciliation",
        detail: "The order outcome is not yet fully proven by the provider.",
        tone: "warning",
        isAiExit: false,
      };
    case "RISK_SESSION_SUSPENDED":
      return {
        label: "AI Trading suspended",
        detail: "The server suspended the trading session because of a risk condition.",
        tone: "danger",
        isAiExit: false,
      };
    default:
      return {
        label: action
          .toLowerCase()
          .split("_")
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        detail: "Server-recorded trading activity.",
        tone: "neutral",
        isAiExit: false,
      };
  }
}

/** Recent AI-exit audit rows, newest first, without mutating the API payload. */
export function aiExitActivityRows(
  activity: readonly LiveActivityRowView[],
): LiveActivityRowView[] {
  return [...activity]
    .filter((row) => activityPresentation(row.action).isAiExit)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
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
