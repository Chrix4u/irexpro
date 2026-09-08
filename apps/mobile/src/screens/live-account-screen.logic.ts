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
