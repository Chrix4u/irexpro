"use client";

import { useEffect, useMemo, useState } from "react";

interface MarketClosedStateProps {
  nextEligibleScanAt: string;
}

function safeDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReopenAt(value: string): string {
  const date = safeDate(value);
  if (!date) return "the next available market session";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function countdownLabel(target: Date | null, nowMs: number): string {
  if (!target) return "Waiting for the next market session";
  const totalSeconds = Math.max(0, Math.ceil((target.getTime() - nowMs) / 1000));
  if (totalSeconds <= 0) return "Opening now";

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [
    days > 0 ? `${days}d` : null,
    days > 0 || hours > 0 ? `${hours}h` : null,
    `${minutes}m`,
    `${seconds}s`,
  ].filter(Boolean);

  return parts.join(" ");
}

export function MarketClosedState({ nextEligibleScanAt }: MarketClosedStateProps) {
  const target = useMemo(() => safeDate(nextEligibleScanAt), [nextEligibleScanAt]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [nextEligibleScanAt]);

  return (
    <section className="market-closed-state" data-testid="market-closed-state" aria-labelledby="market-closed-title">
      <div className="market-closed-state__glow" aria-hidden="true" />
      <div className="market-closed-state__visual" aria-hidden="true">
        <span className="market-closed-state__orbit" />
        <span className="market-closed-state__icon-shell">
          <svg viewBox="0 0 64 64" role="presentation">
            <circle cx="32" cy="32" r="21" />
            <path d="M32 20v13l9 6" />
            <path d="M16 12l-5 5M48 12l5 5" />
          </svg>
        </span>
        <span className="market-closed-state__status-dot" />
      </div>

      <div className="market-closed-state__copy">
        <p className="market-closed-state__eyebrow">AI trading session paused safely</p>
        <h1 id="market-closed-title">Forex market is closed</h1>
        <p className="market-closed-state__lead">
          The weekly FX session is currently closed. iRexPro has paused new AI scans and trade
          entries until fresh market liquidity returns.
        </p>
      </div>

      <div className="market-closed-state__reopen-card">
        <span className="market-closed-state__reopen-label">Expected market reopen</span>
        <strong suppressHydrationWarning>{formatReopenAt(nextEligibleScanAt)}</strong>
        <span className="market-closed-state__local-note">Shown in your local time</span>
      </div>

      <div className="market-closed-state__countdown" data-testid="market-reopen-countdown">
        <span>Reopens in</span>
        <strong suppressHydrationWarning>{countdownLabel(target, nowMs)}</strong>
      </div>

      <div className="market-closed-state__assurance">
        <span className="market-closed-state__assurance-icon" aria-hidden="true">✓</span>
        <p>
          The AI workspace resumes automatically when the authoritative market schedule reports
          OPEN. Existing broker-side risk and protection controls continue on the server; no action
          is required from you.
        </p>
      </div>
    </section>
  );
}
