"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  DashboardShell,
  LoadingSpinner,
} from "@/components/ui";
import { useAuth } from "@/context/auth-context";
import { api } from "@/lib/api";

type Policy =
  | "SIMPLE_FULL_TRAIL"
  | "QUARTER_PARTIAL_RUNNER"
  | "CONFIRMED_TREND_EXIT"
  | "STAGED_PARTIAL_TREND_RUNNER";

interface PolicyResult {
  policy: Policy;
  qualifiedTrades: number;
  tpWinners: number;
  tpWinnersPrematureFullExit: number;
  tpWinnersStillHeldToActualTp: number;
  actualNetPnl: number;
  hypotheticalNetPnl: number;
  hypotheticalNetDelta: number;
  actualNetLosersImproved: number;
  partialRunnerActionCount: number;
  dataSufficientForPromotion: false;
  whyNotPromotable: string;
}

interface TradeAlternative {
  policy: Policy;
  action: "NO_SIGNAL" | "FULL_EXIT" | "PARTIAL_AND_HOLD" | "PARTIAL_AND_EXIT";
  hypotheticalNetPnl: number;
  deltaVsActualNet: number;
  truncatedActualTpWinner: boolean;
}

interface ProtectionTrade {
  closedAt: string;
  instrument: string;
  direction: "BUY" | "SELL";
  strategyRoute: string | null;
  dataQuality:
    | "COMPLETE"
    | "PARTIAL_QUOTE_COVERAGE"
    | "INSUFFICIENT_CAUSAL_MARKS"
    | "INVALID_TRADE";
  actualNetPnl: number;
  actualTpWinner: boolean;
  alternatives: TradeAlternative[];
}

interface ProtectionReplay {
  version: string;
  executionAuthority: "NONE";
  modifiesExecution: false;
  liveStopAmendmentEnabled: false;
  autoPromotionEnabled: false;
  broker: string | null;
  accountCurrency: string | null;
  closedTradesInspected: number;
  completeReplays: number;
  minimumIndependentTradesBeforePromotion: number;
  routeComparisons: PolicyResult[];
  trades: ProtectionTrade[];
  caveats: string[];
}

const POLICY_LABELS: Record<Policy, string> = {
  SIMPLE_FULL_TRAIL: "Conventional trailing exit",
  QUARTER_PARTIAL_RUNNER: "25% profit, 75% TP runner",
  CONFIRMED_TREND_EXIT: "Trend-confirmed full exit",
  STAGED_PARTIAL_TREND_RUNNER: "Partial profit + trend exit",
};

function isReplay(value: unknown): value is ProtectionReplay {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.executionAuthority === "NONE" &&
    r.modifiesExecution === false &&
    r.liveStopAmendmentEnabled === false &&
    r.autoPromotionEnabled === false &&
    typeof r.closedTradesInspected === "number" &&
    typeof r.completeReplays === "number" &&
    Array.isArray(r.routeComparisons) &&
    Array.isArray(r.trades) &&
    Array.isArray(r.caveats)
  );
}

function formatMoney(value: number, currency: string | null): string {
  if (!Number.isFinite(value)) return "—";
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "";
  return `${code} ${value < 0 ? "−" : "+"}${Math.abs(value).toLocaleString(
    undefined,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  )}`.trim();
}

function resultTone(delta: number): string {
  return delta > 0
    ? "var(--color-success, #15905c)"
    : delta < 0
      ? "var(--color-danger, #d05454)"
      : "inherit";
}

export default function SmartProtectionLabPage() {
  const { user, logout, restoring } = useAuth();
  const [report, setReport] = useState<ProtectionReplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request<unknown>(
        "/ai/external/vps-forex/m1-tactical/smart-profit-protection-replay",
      );
      if (!isReplay(response))
        throw new Error("Replay response did not pass validation.");
      setReport(response);
    } catch {
      // Never display stale profitability numbers after a failed or unauthorized read.
      setReport(null);
      setError(
        "Unable to verify the broker-native replay right now. No performance result has been assumed.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  if (restoring) {
    return (
      <div style={{ padding: "3rem" }}>
        <LoadingSpinner text="Restoring session…" />
      </div>
    );
  }
  if (!user) {
    return (
      <div style={{ padding: "3rem", maxWidth: 650, margin: "0 auto" }}>
        <Card title="Sign in required">
          <p>
            The Smart Protection Lab shows only your connected DEMO broker
            account.
          </p>
          <Link href="/login" className="btn btn--primary">
            Sign in
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell
      user={user}
      onLogout={logout}
      activeRoute="/trade"
      title="Smart Protection Lab"
    >
      <main
        className="terminal-foundation"
        data-testid="smart-protection-lab"
        style={{ paddingBottom: "2rem" }}
      >
        <section
          className="terminal-foundation__hero"
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <div style={{ maxWidth: 780 }}>
            <p className="terminal-foundation__eyebrow">
              AI Trader · Post-entry research
            </p>
            <h1 className="terminal-foundation__title">Smart Protection Lab</h1>
            <p className="terminal-foundation__description">
              Compare how different profit-protection approaches might affect
              losing trades and the biggest TP winners, using your broker&apos;s
              past quoted prices. All results are research-only; no broker stops
              or positions are changed.
            </p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: ".5rem",
                alignItems: "center",
              }}
            >
              <Badge variant="info">Shadow only</Badge>
              <Badge variant="warning">No automatic promotion</Badge>
              <Link href="/trade" className="btn btn--ghost btn--sm">
                Back to AI Trading
              </Link>
            </div>
          </div>
          <Button
            variant="secondary"
            loading={loading}
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "Comparing trades…" : "Refresh analysis"}
          </Button>
        </section>

        {error && <Alert variant="error">{error}</Alert>}
        {loading && !report && (
          <LoadingSpinner text="Reviewing your broker-native completed trades…" />
        )}
        {report && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "var(--space-3)",
                margin: "1rem 0",
              }}
            >
              <Card title="Account analyzed">
                <div style={{ fontWeight: 700 }}>
                  {report.broker ?? "No connected DEMO account"}
                </div>
                <p className="muted text-sm">
                  {report.accountCurrency ?? "Unknown currency"} ·
                  Account-isolated
                </p>
              </Card>
              <Card title="Completed trades">
                <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
                  {report.closedTradesInspected}
                </div>
                <p className="muted text-sm">
                  Most recent 14 days; maximum 12 trades
                </p>
              </Card>
              <Card title="Verified replay coverage">
                <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
                  {report.completeReplays}/{report.closedTradesInspected}
                </div>
                <p className="muted text-sm">Broker-native quoted M1 bars</p>
              </Card>
              <Card title="Execution authority">
                <div style={{ fontWeight: 700 }}>NONE</div>
                <p className="muted text-sm">
                  No orders, partial closes or stop changes
                </p>
              </Card>
            </div>
            <Alert variant="warning">
              A historical replay is not a live execution test. None of these
              policies is qualified for automatic deployment. At least{" "}
              {report.minimumIndependentTradesBeforePromotion} independent
              closed-trade observations and prospective broker-fill validation
              are required for further review.
            </Alert>
            <div style={{ marginTop: "1.25rem" }}>
              <Card title="Protection strategy comparison">
                {report.routeComparisons.length === 0 ? (
                  <p className="muted">
                    No settled broker-native performance is available yet.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        borderCollapse: "collapse",
                        width: "100%",
                        minWidth: 800,
                        textAlign: "left",
                      }}
                    >
                      <thead>
                        <tr>
                          {[
                            "Approach",
                            "Usable trades",
                            "Actual net",
                            "Replayed net",
                            "Change",
                            "TP winners cut short",
                            "Losses improved",
                          ].map((heading) => (
                            <th
                              key={heading}
                              style={{
                                padding: ".7rem",
                                borderBottom:
                                  "1px solid var(--border-color, #555)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {heading}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.routeComparisons.map((r) => (
                          <tr key={r.policy}>
                            <td
                              style={{
                                padding: ".75rem",
                                borderBottom:
                                  "1px solid var(--border-color, #555)",
                                fontWeight: 600,
                              }}
                            >
                              {POLICY_LABELS[r.policy]}
                            </td>
                            <td style={{ padding: ".75rem" }}>
                              {r.qualifiedTrades}
                            </td>
                            <td
                              style={{
                                padding: ".75rem",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatMoney(
                                r.actualNetPnl,
                                report.accountCurrency,
                              )}
                            </td>
                            <td
                              style={{
                                padding: ".75rem",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatMoney(
                                r.hypotheticalNetPnl,
                                report.accountCurrency,
                              )}
                            </td>
                            <td
                              style={{
                                padding: ".75rem",
                                whiteSpace: "nowrap",
                                color: resultTone(r.hypotheticalNetDelta),
                                fontWeight: 700,
                              }}
                            >
                              {formatMoney(
                                r.hypotheticalNetDelta,
                                report.accountCurrency,
                              )}
                            </td>
                            <td style={{ padding: ".75rem" }}>
                              {r.tpWinnersPrematureFullExit} / {r.tpWinners}
                            </td>
                            <td style={{ padding: ".75rem" }}>
                              {r.actualNetLosersImproved}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="muted text-sm">
                  Hypothetical results are not broker fills. Different rows may
                  have different eligible samples where M5/M15 context is
                  missing. Compare each approach with its own actual baseline.
                </p>
              </Card>
            </div>
            <div style={{ marginTop: "1.25rem" }}>
              <Card title="Recent completed trades">
                <div style={{ display: "grid", gap: "var(--space-3)" }}>
                  {report.trades.length === 0 && (
                    <p className="muted">
                      No closed trades with complete broker fees were found for
                      this account.
                    </p>
                  )}
                  {report.trades.map((trade, index) => (
                    <div
                      key={`${trade.closedAt}-${trade.instrument}-${index}`}
                      style={{
                        padding: "var(--space-3)",
                        border: "1px solid var(--border-color, #555)",
                        borderRadius: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: ".5rem",
                          alignItems: "center",
                        }}
                      >
                        <strong>
                          {trade.instrument} {trade.direction} ·{" "}
                          {trade.strategyRoute
                            ?.replaceAll("_", " ")
                            .toLowerCase() ?? "Unspecified route"}
                        </strong>
                        <span style={{ fontWeight: 700 }}>
                          {formatMoney(
                            trade.actualNetPnl,
                            report.accountCurrency,
                          )}
                        </span>
                      </div>
                      <p
                        className="muted text-sm"
                        style={{ margin: ".5rem 0" }}
                      >
                        {new Date(trade.closedAt).toLocaleString()} ·{" "}
                        {trade.actualTpWinner ? "TP winner" : "Other close"}
                        {" · "}
                        {trade.dataQuality
                          .replaceAll("_", " ")
                          .toLowerCase()}{" "}
                        evidence
                      </p>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: ".65rem",
                        }}
                      >
                        {trade.alternatives.map((candidate) => (
                          <span
                            key={candidate.policy}
                            style={{
                              fontSize: ".8rem",
                              color: resultTone(candidate.deltaVsActualNet),
                            }}
                          >
                            {POLICY_LABELS[candidate.policy]}:{" "}
                            {formatMoney(
                              candidate.deltaVsActualNet,
                              report.accountCurrency,
                            )}
                            {candidate.truncatedActualTpWinner
                              ? " · cut TP winner"
                              : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
            <div style={{ marginTop: "1.25rem" }}>
              <Card title="What the analysis can and cannot prove">
                <ul
                  style={{
                    paddingLeft: "1.35rem",
                    display: "grid",
                    gap: ".5rem",
                  }}
                >
                  {report.caveats.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Card>
            </div>
          </>
        )}
      </main>
    </DashboardShell>
  );
}
