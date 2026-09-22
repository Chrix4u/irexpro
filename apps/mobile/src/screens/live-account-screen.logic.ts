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
  LiveAccountConnectionView,
  LiveAccountEnvironment,
  LiveAccountOverviewView,
  LiveActivityRowView,
  LivePositionRowView,
  LiveReadinessView,
} from "@irexpro/types";
import type {
  ManualPositionCloseOutcome,
  TradingSessionView,
} from "@irexpro/types/execution";

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



// ── Margin tiles + per-connection reconciliation (production-LIVE
//    completion round — audit P8: no margin display, no per-connection recon
//    summary) ──────────────────────────────────────────────────────────────

export interface MarginTilesView {
  /** False when no synchronized broker financial snapshot exists (honest empties). */
  available: boolean;
  currency: string | null;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  /** Equity-to-margin ratio — null when no margin is in use (never fabricated). */
  marginLevel: string | null;
}

/**
 * Margin presentation for the primary connection's financial summary.
 * All monetary values remain decimal STRINGS (never parsed to floats); a
 * missing financial snapshot renders honest em-dashes, never a zero.
 */
export function marginTiles(overview: LiveAccountOverviewView): MarginTilesView {
  const financial = overview.connections[0]?.financial ?? null;
  if (!financial) {
    return {
      available: false,
      currency: null,
      balance: "—",
      equity: "—",
      margin: "—",
      freeMargin: "—",
      marginLevel: null,
    };
  }
  return {
    available: true,
    currency: financial.currency,
    balance: financial.balance,
    equity: financial.equity,
    margin: financial.margin,
    freeMargin: financial.freeMargin,
    marginLevel: financial.marginLevel,
  };
}

export type ReconciliationTone = "good" | "warn" | "bad" | "neutral";

export interface ReconciliationSummaryView {
  /** True when reconciliationLoaded === false — the degraded fail-closed state. */
  unavailable: boolean;
  statusLabel: string;
  tone: ReconciliationTone;
  /** Open-discrepancy counts, critical first. */
  discrepancyLabel: string;
  /** Server-derived inSync (only meaningful when the summary was loaded). */
  inSync: boolean;
  lastRunLabel: string;
}

const RECONCILIATION_STATUS_PRESENTATION: Record<
  NonNullable<LiveAccountConnectionView["reconciliation"]["lastRunStatus"]>,
  { label: string; tone: ReconciliationTone }
> = {
  PENDING: { label: "Pending", tone: "neutral" },
  RUNNING: { label: "Running now", tone: "neutral" },
  COMPLETED: { label: "Completed", tone: "good" },
  COMPLETED_WITH_WARNINGS: { label: "Completed with warnings", tone: "warn" },
  FAILED: { label: "Failed", tone: "bad" },
};

/**
 * Per-connection reconciliation presentation (fail-closed): when the server
 * could not read the reconciliation store (reconciliationLoaded === false),
 * the zero-valued counts must NEVER be rendered as "zero discrepancies" or an
 * in-sync state — the surface says "unavailable" instead.
 */
export function reconciliationSummary(
  connection: Pick<LiveAccountConnectionView, "reconciliation">,
  reconciliationLoaded: boolean | undefined,
): ReconciliationSummaryView {
  if (reconciliationLoaded === false) {
    return {
      unavailable: true,
      statusLabel: "Unavailable",
      tone: "warn",
      discrepancyLabel:
        "Reconciliation status unavailable — the server could not read the reconciliation store.",
      inSync: false,
      lastRunLabel: "Last run unknown",
    };
  }

  const summary = connection.reconciliation;
  const status = summary.lastRunStatus
    ? (RECONCILIATION_STATUS_PRESENTATION[summary.lastRunStatus] ?? {
        label: summary.lastRunStatus,
        tone: "neutral" as ReconciliationTone,
      })
    : { label: "Not yet reconciled", tone: "neutral" as ReconciliationTone };

  const discrepancyLabel =
    summary.openDiscrepancies === 0 && summary.openCritical === 0 && summary.openWarning === 0
      ? "No open discrepancies"
      : `${summary.openCritical} critical · ${summary.openWarning} warning · ${summary.openDiscrepancies} open`;

  return {
    unavailable: false,
    statusLabel: status.label,
    tone: status.tone,
    discrepancyLabel,
    inSync: summary.inSync,
    lastRunLabel: summary.lastRunAt
      ? `Last run ${new Date(summary.lastRunAt).toLocaleString()}`
      : "Never run",
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

// ── Manual single-position close (October UAT hardening — WS1) ──────────────
//
// The Close button on each OPEN position card posts to
// /execution/positions/:tradeId/close — the SAME server execution domain as
// AI exits, Stop flatten, and the kill switch. The SERVER classifies the
// attempt honestly; this mapping only renders that classification. It never
// infers a close the server did not confirm, and Start/Stop AI Trading
// semantics are untouched by a per-position close.

export type ManualCloseTone = "success" | "info" | "warning" | "error";

export interface ManualClosePresentation {
  /** Alert title. */
  title: string;
  /** Body — the SERVER message verbatim (never invented copy). */
  message: string;
  /** Presentation tone for testing / future in-app surfaces. */
  tone: ManualCloseTone;
}

interface ManualCloseOutcomeCopy {
  title: string;
  tone: ManualCloseTone;
  /** Fixed honest explanation prepended when the outcome needs one. */
  detail: string | null;
}

const MANUAL_CLOSE_OUTCOMES: Record<
  ManualPositionCloseOutcome,
  ManualCloseOutcomeCopy
> = {
  CLOSED: {
    title: "Position closed",
    tone: "success",
    detail: null,
  },
  ALREADY_CLOSED: {
    title: "Already closed",
    tone: "info",
    detail: null,
  },
  CLOSE_IN_PROGRESS: {
    title: "Close already in flight",
    tone: "info",
    detail: null,
  },
  RECONCILIATION_REQUIRED: {
    title: "Provider confirmation pending",
    tone: "warning",
    detail:
      "Provider confirmation pending — reconciliation will resolve the final state.",
  },
  PROVIDER_REFUSED: {
    title: "Close refused",
    tone: "error",
    detail: null,
  },
};

/**
 * Outcome → presentation mapping for ONE manual close attempt (pure).
 *
 * The provider-refused branch appends the SANITIZED provider error class
 * (server-classified; never credentials or raw provider payloads).
 *
 * Fail-closed: an UNRECOGNIZED runtime outcome (contract violation) renders
 * as an honest unknown-state error — never as a closed/success claim —
 * because the client must never present an unproven close. The Positions
 * list remains the authoritative open-state surface.
 */
export function manualClosePresentation(
  outcome: ManualPositionCloseOutcome,
  serverMessage: string,
  providerErrorClass: string | null = null,
): ManualClosePresentation {
  const copy = MANUAL_CLOSE_OUTCOMES[outcome];
  if (!copy) {
    return {
      title: "Close result unknown",
      tone: "error",
      message:
        "The server returned an unrecognized close result. The position was not changed locally — check the Positions list for the authoritative state.",
    };
  }

  const parts: string[] = [];
  if (copy.detail) parts.push(copy.detail);
  const message = serverMessage.trim();
  if (message.length > 0) parts.push(message);
  if (
    copy.tone === "error" &&
    providerErrorClass &&
    providerErrorClass.trim().length > 0
  ) {
    parts.push(`Provider error class: ${providerErrorClass.trim()}`);
  }

  return {
    title: copy.title,
    tone: copy.tone,
    message:
      parts.length > 0
        ? parts.join("\n\n")
        : "The server did not return a message. Check the Positions list for the authoritative state.",
  };
}

/**
 * Confirmation-dialog copy for closing ONE position (pure). Identifies the
 * exact position (symbol/direction/lots) and states the scope boundary:
 * a manual close is per-position and never touches AI Trading or other
 * positions.
 */
export function manualCloseConfirmationMessage(
  position: Pick<
    LivePositionRowView,
    "instrument" | "direction" | "lotSize"
  >,
): string {
  return (
    `${position.instrument} ${position.direction} · ${position.lotSize} lots\n\n` +
    "This closes only this position. AI Trading and other positions are not affected."
  );
}

// ── Trading readiness states (October UAT hardening — WS5) ──────────────────
//
// Six SEPARATED operating states, each carrying its OWN truth: a DEMO
// validation is never a broker LIVE certification; a certified broker never
// implies the active AI model is approved; a LIVE-approved model never
// implies the broker is certified. These rows are presentation only — the
// SERVER readiness payload remains the enforcement truth.

export interface ReadinessDisplayRow {
  key:
    | "paper"
    | "demo"
    | "brokerLiveCertified"
    | "modelPaperApproved"
    | "modelLiveApproved"
    | "liveTradingEnabled";
  /** Category label (row left side). */
  label: string;
  /** Unambiguous status text — NEVER a bare "Verified". */
  statusText: string;
  /** True only when this exact state is positively met (green). */
  met: boolean;
  /** Honest detail from the server payload (never inferred locally). */
  detail: string | null;
}

/**
 * Derive the six separated readiness display rows (pure). Null model states
 * render as UNKNOWN — the runtime honestly reported it could not determine
 * approval, which is never rendered as approved.
 */
export function readinessDisplayRows(
  readiness: LiveReadinessView,
): ReadinessDisplayRow[] {
  const modelDetail = readiness.model.activeModelVersion
    ? `Active model: ${readiness.model.activeModelVersion}`
    : "No active model in the AI runtime";
  const certifiedProviders =
    readiness.brokerLiveCertified.certifiedProviders;
  return [
    {
      key: "paper",
      label: "Paper trading",
      statusText: readiness.paper.ready
        ? "PAPER READY"
        : "PAPER NOT READY",
      met: readiness.paper.ready,
      detail: null,
    },
    {
      key: "demo",
      label: "Demo verification",
      statusText: readiness.demo.verified
        ? "DEMO VERIFIED"
        : "DEMO NOT VALIDATED",
      met: readiness.demo.verified,
      detail: null,
    },
    {
      key: "brokerLiveCertified",
      label: "Broker LIVE certification",
      statusText: readiness.brokerLiveCertified.certified
        ? "BROKER LIVE CERTIFIED"
        : "BROKER NOT LIVE CERTIFIED",
      met: readiness.brokerLiveCertified.certified,
      detail:
        certifiedProviders.length > 0
          ? `Certified providers: ${certifiedProviders.join(", ")}`
          : null,
    },
    {
      key: "modelPaperApproved",
      label: "AI model — paper approval",
      statusText:
        readiness.model.paperApproved === null
          ? "MODEL STATUS UNKNOWN"
          : readiness.model.paperApproved
            ? "MODEL PAPER APPROVED"
            : "MODEL NOT PAPER APPROVED",
      met: readiness.model.paperApproved === true,
      detail: modelDetail,
    },
    {
      key: "modelLiveApproved",
      label: "AI model — LIVE approval",
      statusText: readiness.model.liveApproved
        ? "MODEL LIVE APPROVED"
        : "MODEL NOT LIVE APPROVED",
      met: readiness.model.liveApproved,
      detail: readiness.model.liveActivationReason ?? modelDetail,
    },
    {
      key: "liveTradingEnabled",
      label: "Live trading enablement",
      statusText: readiness.liveTradingEnabled.enabled
        ? "LIVE TRADING ENABLED"
        : "LIVE TRADING NOT ENABLED",
      met: readiness.liveTradingEnabled.enabled,
      detail: null,
    },
  ];
}

export interface ReadinessBlockerRow {
  reasonCode: string;
  /** Server message VERBATIM — the client never invents blocker copy. */
  message: string;
}

/**
 * Real-money trading blockers in server order, verbatim (pure passthrough).
 * Empty only when every LIVE gate is genuinely satisfied.
 */
export function readinessBlockerRows(
  readiness: LiveReadinessView,
): ReadinessBlockerRow[] {
  return readiness.liveBlockers.map((blocker) => ({
    reasonCode: blocker.reasonCode,
    message: blocker.message,
  }));
}
