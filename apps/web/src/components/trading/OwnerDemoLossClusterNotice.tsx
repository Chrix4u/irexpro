"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { OwnerDemoLossCluster } from "@/lib/owner-demo-loss-cluster";
import "./portfolio-loss-pause.css";

interface Props {
  incident: OwnerDemoLossCluster | null;
  brokerConnectionId: string | null;
  active: boolean;
  deferAutoOpen?: boolean;
  onReviewStop: () => void;
}
const fmt = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(usd);

/**
 * Inform owner of a new cluster of broker-settled losses.
 * Continue acknowledges; Stop opens the EXISTING Stop Trading confirmation.
 * Neither action here changes broker state, strategy admissions, or risk gates.
 */
export function OwnerDemoLossClusterNotice({
  incident, brokerConnectionId, active, deferAutoOpen = false, onReviewStop,
}: Props) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeIncidentKey, setActiveIncidentKey] = useState<string | null>(null);
  const titleId = useId(), descId = useId();
  const firstButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const key = active && incident && brokerConnectionId
    ? "irexpro:demo-loss-cluster:" + brokerConnectionId + ":" + incident.incidentId
    : null;

  useEffect(() => {
    if (!key) {
      setReviewOpen(false);
      setActiveIncidentKey(null);
      return;
    }
    if (deferAutoOpen || activeIncidentKey === key) return;
    setActiveIncidentKey(key);
    try {
      if (window.sessionStorage.getItem(key) === "reviewed") return;
    } catch { /* Private browsing can disable session storage. */ }
    setReviewOpen(true);
  }, [key, deferAutoOpen, activeIncidentKey]);

  useEffect(() => {
    if (!reviewOpen || !key) return;
    const savedOverflow = document.body.style.overflow;
    previousFocus.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const focusId = requestAnimationFrame(() => firstButton.current?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        acknowledge();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
      );
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons[buttons.length - 1].focus();
      } else if (!event.shiftKey &&
        document.activeElement === buttons[buttons.length - 1]) {
        event.preventDefault();
        buttons[0].focus();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      cancelAnimationFrame(focusId);
      document.removeEventListener("keydown", handleKey, true);
      document.body.style.overflow = savedOverflow;
      previousFocus.current?.focus?.();
    };
  // acknowledge() only mutates local state. Do not rewire this effect to trade controls.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen, key]);

  function acknowledge() {
    if (key) {
      try { window.sessionStorage.setItem(key, "reviewed"); }
      catch { /* Keep in-memory identity so polling does not reopen. */ }
    }
    setReviewOpen(false);
  }
  if (!key || !incident) return null;
  const reviewStop = () => {
    acknowledge();
    onReviewStop(); // Existing confirmation explains Stop closes AI positions.
  };
  return (
    <>
      <section role="alert" className="portfolio-brake-alert"
        data-testid="owner-demo-loss-cluster-banner">
        <div className="portfolio-brake-alert__header">
          <strong>Recent DEMO losses — owner review</strong>
          <span className="portfolio-brake-alert__tag">Pepperstone · USD DEMO</span>
        </div>
        <p>
          Two broker-settled positions closed at a combined{" "}
          <strong>{fmt(incident.netUsd)}</strong>. AI Trading is still running.
          No strategy has been automatically paused by this alert.
        </p>
        <button type="button" className="btn btn--secondary"
          onClick={() => setReviewOpen(true)}>Review loss alert</button>
      </section>
      {reviewOpen && (
        <div className="portfolio-brake-overlay">
          <section role="alertdialog" aria-modal="true"
            ref={panel} tabIndex={-1} aria-labelledby={titleId}
            aria-describedby={descId}
            className="portfolio-brake-dialog"
            data-testid="owner-demo-loss-cluster-dialog">
            <header>
              <span className="portfolio-brake-alert__tag">Pepperstone USD DEMO</span>
              <h2 id={titleId}>Two recent trades closed at a loss</h2>
            </header>
            <p id={descId}>
              These positions lost <strong>{fmt(incident.netUsd)}</strong> net
              after broker commission. Do you want AI Trading to continue,
              or review stopping it?
            </p>
            <div className="strategy-loss-alert__items">
              {incident.trades.map((trade) => (
                <div key={trade.id} className="strategy-loss-alert__item">
                  <strong>{trade.instrument} {trade.direction}</strong>
                  <span>{fmt(trade.netUsd)}</span>
                </div>
              ))}
            </div>
            <p>
              Choosing Continue leaves your existing AI Trading session running.
              Choosing Stop opens the normal confirmation. Confirmed Stop also
              requests closure of AI-opened positions.
            </p>
            <div className="portfolio-brake-actions">
              <button type="button" ref={firstButton}
                className="btn btn--secondary" onClick={acknowledge}>
                Continue Trading
              </button>
              <button type="button" className="btn btn--danger"
                onClick={reviewStop}>
                Stop Trading…
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
