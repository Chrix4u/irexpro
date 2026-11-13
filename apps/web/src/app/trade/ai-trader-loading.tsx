import "./ai-trader.css";

/**
 * Stable AI workstation preloader. It never invents equity, P&L or trading
 * authority while authoritative broker data is still being verified.
 */
export function AiTraderLoading() {
  return (
    <main className="ai-trader ai-loading-workspace" data-testid="ai-trader-loading" aria-busy="true" aria-label="Loading AI Trading workspace">
      <section className="ai-trader__hero ai-loading-hero">
        <div>
          <p className="workspace-hero__eyebrow">Autonomous trading control</p>
          <h1>AI Trader</h1>
          <p>Connecting your broker account and preparing verified trading information.</p>
        </div>
        <div className="ai-loading-indicator" role="status" aria-live="polite">
          <span className="ai-loading-indicator__ring" aria-hidden="true" />
          <span>Preparing workspace…</span>
        </div>
      </section>
      <section className="ai-kpi-grid" aria-label="Loading account overview">
        {["Equity", "AI Allocation", "24h Net P&L", "Open P&L"].map((label) => (
          <article key={label} className="ai-kpi-card ai-loading-kpi">
            <span className="ai-kpi-card__label">{label}</span>
            <span className="ai-loading-shimmer ai-loading-shimmer--value" aria-hidden="true" />
            <span className="ai-loading-shimmer ai-loading-shimmer--hint" aria-hidden="true" />
          </article>
        ))}
      </section>
      <section className="ai-loading-model" aria-label="Loading decision engine">
        <div>
          <span className="ai-loading-shimmer ai-loading-shimmer--label" aria-hidden="true" />
          <span className="ai-loading-shimmer ai-loading-shimmer--wide" aria-hidden="true" />
        </div>
        <span className="ai-loading-shimmer ai-loading-shimmer--badge" aria-hidden="true" />
      </section>
      <section className="ai-loading-panels" aria-label="Loading AI strategy and charts">
        <div className="ai-loading-panel">
          <span className="ai-loading-shimmer ai-loading-shimmer--label" aria-hidden="true" />
          <span className="ai-loading-pulse" aria-hidden="true">
            <span className="ai-loading-pulse__scan" />
          </span>
          <span className="ai-loading-shimmer ai-loading-shimmer--wide" aria-hidden="true" />
          <span className="ai-loading-shimmer ai-loading-shimmer--hint" aria-hidden="true" />
        </div>
        <div className="ai-loading-panel">
          <span className="ai-loading-shimmer ai-loading-shimmer--label" aria-hidden="true" />
          <div className="ai-loading-chart" aria-hidden="true">
            {[28,48,35,68,54,83,58,73,39,62,50,89,64,78,43,65,84,55,76,42].map((height, index) => (
              <span key={index} style={{ height: `${height}%` }} />
            ))}
          </div>
          <span className="ai-loading-shimmer ai-loading-shimmer--wide" aria-hidden="true" />
        </div>
      </section>
      <p className="ai-loading-footnote" role="status" aria-live="polite">
        <span className="ai-loading-footnote__dot" aria-hidden="true" />
        Verifying broker balances, risk controls, market data and recent executions. Trading continues on the server independently of this page.
      </p>
    </main>
  );
}

export default function LoadingAiTradingRoute() {
  return <AiTraderLoading />;
}
