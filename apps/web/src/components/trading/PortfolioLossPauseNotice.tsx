"use client";
import { useEffect, useId, useRef, useState } from "react";
import "./portfolio-loss-pause.css";

export interface PortfolioLossPauseStatus {
  supported: boolean;
  state: "UNAVAILABLE" | "CLEAR" | "PAUSED" | "WAITING" | "OVERRIDDEN";
  active: boolean;
  requiresOwnerDecision: boolean;
  resumeAuthorized: boolean;
  userDecision: "RESUME" | "KEEP_PAUSED" | null;
  incidentClosedAt: string | null;
  brakeExpiresAt: string | null;
  remainingSeconds: number;
  consecutiveNetLosses: number;
  lastThreeNetUsd: number | null;
  recentLosses: { closedAt: string; instrument: string; direction: string; netUsd: number }[];
  reason: string;
  brokerAccountType: "DEMO" | null;
  currency: "USD" | null;
  canOverrideCurrentIncident: boolean;
  otherRiskChecksRemainActive: true;
}
interface Props {
  status: PortfolioLossPauseStatus | null;
  saving?: boolean;
  error?: string | null;
  onDecision: (
    action: "RESUME" | "KEEP_PAUSED",
    acknowledged: boolean,
    incidentClosedAt: string,
  ) => Promise<void>;
}
const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
const time = (value: string | null) => {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" :
    date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
export function shouldShowPortfolioBrakeNotice(status: PortfolioLossPauseStatus | null): boolean {
  return status?.supported === true && status.active === true &&
    status.incidentClosedAt !== null;
}

/** Persistent banner + explicit owner risk acknowledgement for each DEMO incident. */
export function PortfolioLossPauseNotice({ status, saving = false, error, onDecision }: Props) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const lastAutoOpened = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const visible = shouldShowPortfolioBrakeNotice(status);
  const incident = visible ? status!.incidentClosedAt : null;
  const busy = saving || localBusy;

  useEffect(() => {
    if (!incident) {
      setReviewOpen(false);
      lastAutoOpened.current = null;
      return;
    }
    if (status?.requiresOwnerDecision && status.state === "PAUSED" &&
        lastAutoOpened.current !== incident) {
      lastAutoOpened.current = incident;
      setAcknowledged(false);
      setReviewOpen(true);
    }
  }, [incident, status?.requiresOwnerDecision, status?.state]);

  useEffect(() => {
    if (!reviewOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => cancelRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setReviewOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [reviewOpen, busy]);

  if (!visible || !status || !incident) return null;
  const overridden = status.state === "OVERRIDDEN";
  const waiting = status.state === "WAITING";
  const summary = status.lastThreeNetUsd !== null
    ? String(status.consecutiveNetLosses) + " net losses (" + money(status.lastThreeNetUsd) + ")"
    : String(status.consecutiveNetLosses) + " net losses";
  const choose = async (action: "RESUME" | "KEEP_PAUSED") => {
    if (busy || (action === "RESUME" && !acknowledged)) return;
    setLocalBusy(true);
    try {
      await onDecision(action, action === "RESUME" && acknowledged, incident);
      setReviewOpen(false);
      setAcknowledged(false);
    } catch {
      // Failed server approvals never imply continued trading.
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <>
      <section className={"portfolio-brake-alert" +
        (overridden ? " portfolio-brake-alert--accepted" : "")}
        role="alert" aria-live="assertive" data-testid="portfolio-loss-pause-alert">
        <div className="portfolio-brake-alert__header">
          <span className="portfolio-brake-alert__tag">DEMO · PORTFOLIO RISK</span>
          <strong>{overridden ? "Owner approved continued DEMO trading" :
            waiting ? "Safety pause kept by account owner" :
              "New AI entries paused after consecutive losses"}</strong>
        </div>
        <p>{summary}. {overridden
          ? "Additional DEMO loss risk was accepted for this incident."
          : "New entries are paused by the portfolio-loss safeguard."}{" "}
          {status.brakeExpiresAt
            ? "Original pause expires " + time(status.brakeExpiresAt) + "." : ""}
        </p>
        <p className="portfolio-brake-alert__fine">
          Stop-loss, margin, drawdown and all other model/risk controls remain active.
        </p>
        <button type="button" className="portfolio-brake-alert__review"
          onClick={() => { setAcknowledged(false); setReviewOpen(true); }}>
          {overridden ? "Reinstate safety pause" : "Review risk and choose"}
        </button>
      </section>
      {reviewOpen && (
        <div className="portfolio-brake-overlay">
          <section role="alertdialog" aria-modal="true"
            aria-labelledby={titleId} aria-describedby={descriptionId}
            className="portfolio-brake-dialog" data-testid="portfolio-loss-pause-dialog">
            <header>
              <span className="portfolio-brake-alert__tag">DEMO TRADING · ACCOUNT RISK</span>
              <h2 id={titleId}>AI trading paused after losses</h2>
            </header>
            <p id={descriptionId}>
              The account recorded {summary}. You can wait for the two-hour pause
              to expire, or explicitly authorize additional DEMO trading risk.
            </p>
            <div className="portfolio-brake-facts">
              <div><span>Consecutive losses</span>
                <strong>{status.consecutiveNetLosses}</strong></div>
              <div><span>Combined net result</span>
                <strong>{status.lastThreeNetUsd === null
                  ? "Unavailable" : money(status.lastThreeNetUsd)}</strong></div>
              <div><span>Normal pause expiry</span>
                <strong>{time(status.brakeExpiresAt)}</strong></div>
            </div>
            {status.recentLosses.length > 0 && (
              <div className="portfolio-brake-losses" aria-label="Recent broker losses">
                {status.recentLosses.map((loss, index) => (
                  <div key={loss.closedAt + String(index)}>
                    <span>{loss.instrument} {loss.direction}</span>
                    <strong>{money(loss.netUsd)}</strong>
                  </div>
                ))}
              </div>
            )}
            <p className="portfolio-brake-warning">
              <strong>Risk warning:</strong> Resuming may produce further losses and
              lower your DEMO equity. Consent applies only to this incident and
              does not reset trading losses, increase lot size, or override other safeguards.
            </p>
            {!overridden && (
              <label className="portfolio-brake-checkbox">
                <input type="checkbox" checked={acknowledged} disabled={busy}
                  onChange={(e) => setAcknowledged(e.target.checked)} />
                <span>I understand that continuing DEMO trading during a
                  loss-streak pause may cause additional losses.</span>
              </label>
            )}
            {error && <p className="portfolio-brake-error" role="alert">{error}</p>}
            <div className="portfolio-brake-actions">
              <button type="button" ref={cancelRef} className="btn btn--secondary"
                disabled={busy} onClick={() => setReviewOpen(false)}>Review later</button>
              <button type="button" className="btn btn--secondary" disabled={busy}
                onClick={() => void choose("KEEP_PAUSED")}>
                {overridden ? "Reinstate safety pause" : "Keep trading paused"}
              </button>
              {!overridden && (
                <button type="button" className="btn btn--danger"
                  disabled={!acknowledged || busy || !status.canOverrideCurrentIncident}
                  onClick={() => void choose("RESUME")}>
                  {busy ? "Saving choice…" : "Accept risk · Resume DEMO entries"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
