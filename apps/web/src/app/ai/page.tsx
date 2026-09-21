'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEnumLabel } from '@irexpro/types';
import type {
  AiDecisionExplorerView,
  AiDecisionOutcome,
  AiDecisionSummaryView,
} from '@irexpro/types/ai-decision-explorer';
import { Alert, Badge, Button, Card, DashboardShell, EmptyState, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { loadAiDecisionExplorer } from '@/lib/ai-decision-explorer';

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatScore(value: number | null): string {
  return value === null ? 'Not available' : `${Math.round(value * 100)}%`;
}

function outcomeVariant(outcome: AiDecisionOutcome): 'success' | 'error' | 'warning' | 'info' {
  if (outcome === 'EXECUTION_SUCCEEDED' || outcome === 'RISK_APPROVED') return 'success';
  if (outcome === 'RISK_REJECTED' || outcome === 'EXECUTION_FAILED') return 'error';
  if (outcome === 'IGNORED') return 'warning';
  return 'info';
}

function contextVariant(
  status: NonNullable<AiDecisionSummaryView['agentContext']>['status'],
): 'success' | 'error' | 'warning' | 'info' {
  if (status === 'ALIGNED') return 'success';
  if (status === 'BLOCKED') return 'error';
  if (status === 'CONFLICT') return 'warning';
  return 'info';
}

function decisionTitle(decision: AiDecisionSummaryView): string {
  const instrument = decision.evidence.instrument ?? 'Instrument unavailable';
  const direction = decision.evidence.direction ? ` · ${decision.evidence.direction}` : '';
  return `${instrument}${direction}`;
}

export default function AiDecisionExplorerPage() {
  const { user, logout, restoring } = useAuth();
  const [snapshot, setSnapshot] = useState<AiDecisionExplorerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await loadAiDecisionExplorer());
    } catch {
      setSnapshot(null);
      setError(
        'Unable to load persisted AI decision evidence. Previously loaded decision state has been cleared.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  const summary = useMemo(() => {
    const decisions = snapshot?.decisions ?? [];
    return {
      total: decisions.length,
      executed: decisions.filter((decision) => decision.outcome === 'EXECUTION_SUCCEEDED').length,
      vetoed: decisions.filter((decision) => decision.outcome === 'RISK_REJECTED').length,
      ignored: decisions.filter((decision) => decision.outcome === 'IGNORED').length,
    };
  }, [snapshot]);

  if (restoring) {
    return (
      <div style={{ padding: '3rem' }}>
        <LoadingSpinner text="Restoring session…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to inspect your AI decision evidence.</p>
          <Link href="/login" className="btn btn--primary mt-4">
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/ai" title="AI Decision Explorer">
      <main className="terminal-foundation">
        <section className="terminal-foundation__hero" aria-labelledby="ai-decision-title">
          <div>
            <p className="terminal-foundation__eyebrow">Autonomous decision evidence</p>
            <h1 id="ai-decision-title" className="terminal-foundation__title">
              AI Decision Explorer
            </h1>
            <p className="terminal-foundation__description">
              Inspect persisted signal provenance, eligibility gates, risk approval or veto, and execution lifecycle. This surface reports recorded evidence only; it does not expose hidden model reasoning or reconstruct missing facts in the browser.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={loading}
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? 'Refreshing…' : 'Refresh decisions'}
          </Button>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {loading && !snapshot ? (
          <Card title="Loading decision evidence" className="mt-4">
            <LoadingSpinner text="Reading persisted signal, risk, and execution evidence…" />
          </Card>
        ) : snapshot ? (
          <>
            <section
              className="mt-4"
              aria-label="Decision summary"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Card title="Recent Decisions">
                <strong style={{ fontSize: '1.75rem' }}>{summary.total}</strong>
                <p className="text-sm muted mt-1">Persisted signal receipts</p>
              </Card>
              <Card title="Execution Accepted">
                <strong style={{ fontSize: '1.75rem' }}>{summary.executed}</strong>
                <p className="text-sm muted mt-1">Approved signals accepted by execution</p>
              </Card>
              <Card title="Risk Vetoes">
                <strong style={{ fontSize: '1.75rem' }}>{summary.vetoed}</strong>
                <p className="text-sm muted mt-1">Signals blocked by the risk engine</p>
              </Card>
              <Card title="Eligibility Stops">
                <strong style={{ fontSize: '1.75rem' }}>{summary.ignored}</strong>
                <p className="text-sm muted mt-1">Signals stopped before risk execution</p>
              </Card>
            </section>

            <section className="mt-4">
              <Card
                title="Decision Timeline"
                subtitle={`Evidence snapshot generated ${formatTimestamp(snapshot.generatedAt)}`}
              >
                {snapshot.decisions.length === 0 ? (
                  <EmptyState
                    icon="◎"
                    title="No persisted AI decisions yet"
                    description="Decision evidence will appear here after the AI signal pipeline records activity for this account."
                  />
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
                    {snapshot.decisions.map((decision) => (
                      <article
                        key={decision.signalId}
                        style={{
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--radius-lg)',
                          padding: 'var(--space-4)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 'var(--space-3)',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div>
                            <h3 style={{ margin: 0 }}>{decisionTitle(decision)}</h3>
                            <p className="text-sm muted mt-1">
                              Received {formatTimestamp(decision.receivedAt)}
                            </p>
                          </div>
                          <Badge variant={outcomeVariant(decision.outcome)}>
                            {formatEnumLabel(decision.outcome)}
                          </Badge>
                        </div>

                        <div
                          className="mt-4"
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                            gap: 'var(--space-3)',
                          }}
                        >
                          <div>
                            <span className="text-sm muted">Confidence</span>
                            <div>{formatScore(decision.evidence.confidenceScore)}</div>
                          </div>
                          <div>
                            <span className="text-sm muted">Strategy</span>
                            <div>{decision.evidence.strategyCode ?? 'Not available'}</div>
                          </div>
                          <div>
                            <span className="text-sm muted">Model version</span>
                            <div>{decision.evidence.modelVersion ?? 'Not available'}</div>
                          </div>
                          <div>
                            <span className="text-sm muted">Timeframe</span>
                            <div>{decision.evidence.timeframe ?? 'Not available'}</div>
                          </div>
                          <div>
                            <span className="text-sm muted">Market regime</span>
                            <div>{decision.evidence.marketRegime ?? 'Not available'}</div>
                          </div>
                          <div>
                            <span className="text-sm muted">Volatility score</span>
                            <div>{formatScore(decision.evidence.volatilityScore)}</div>
                          </div>
                        </div>

                        <div className="mt-4">
                          <span className="text-sm muted">Agent Council context</span>
                          {decision.agentContext ? (
                            <div
                              className="mt-2"
                              style={{
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-md)',
                                padding: 'var(--space-3)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 'var(--space-2)',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <Badge variant={contextVariant(decision.agentContext.status)}>
                                  {formatEnumLabel(decision.agentContext.status)}
                                </Badge>
                                <span className="text-sm muted">
                                  Source {formatEnumLabel(decision.agentContext.sourceState)}
                                </span>
                                <span className="text-sm muted">
                                  Evaluated {formatTimestamp(decision.agentContext.evaluatedAt)}
                                </span>
                              </div>
                              <div
                                className="mt-3"
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                                  gap: 'var(--space-3)',
                                }}
                              >
                                <div>
                                  <span className="text-sm muted">Consensus</span>
                                  <div>{formatEnumLabel(decision.agentContext.consensusDirection)}</div>
                                </div>
                                <div>
                                  <span className="text-sm muted">Disagreement</span>
                                  <div>{formatScore(decision.agentContext.disagreementScore)}</div>
                                </div>
                                <div>
                                  <span className="text-sm muted">Evidence used</span>
                                  <div>{decision.agentContext.evidenceCount}</div>
                                </div>
                                <div>
                                  <span className="text-sm muted">Rejected evidence</span>
                                  <div>{decision.agentContext.rejectedCount}</div>
                                </div>
                              </div>
                              {decision.agentContext.evidence.length > 0 && (
                                <ul
                                  className="mt-3"
                                  style={{
                                    display: 'grid',
                                    gap: 'var(--space-2)',
                                    marginBottom: 0,
                                    paddingLeft: '1.25rem',
                                  }}
                                >
                                  {decision.agentContext.evidence.map((item) => (
                                    <li key={item.sourceId}>
                                      <strong>{formatEnumLabel(item.stance)}</strong>
                                      {' · '}
                                      {item.summary}
                                      <span className="text-sm muted">
                                        {' '}
                                        · {item.verifiedSources} verified source
                                        {item.verifiedSources === 1 ? '' : 's'}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <p className="text-sm muted mt-3" style={{ marginBottom: 0 }}>
                                Advisory evidence only. The Risk Engine and Execution Engine remain
                                authoritative.
                              </p>
                            </div>
                          ) : (
                            <p className="text-sm muted mt-1">Not recorded for this decision.</p>
                          )}
                        </div>

                        <div
                          className="mt-4"
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                            gap: 'var(--space-3)',
                          }}
                        >
                          <div>
                            <span className="text-sm muted">Risk decision</span>
                            <div className="mt-1">
                              <Badge
                                variant={
                                  decision.risk.decision === 'APPROVED'
                                    ? 'success'
                                    : decision.risk.decision === 'REJECTED'
                                      ? 'error'
                                      : 'info'
                                }
                              >
                                {formatEnumLabel(decision.risk.decision)}
                              </Badge>
                            </div>
                            {decision.risk.rejectionCode && (
                              <p className="text-sm mt-2">
                                {formatEnumLabel(decision.risk.rejectionCode)}
                                {decision.risk.rejectionReason
                                  ? ` — ${decision.risk.rejectionReason}`
                                  : ''}
                              </p>
                            )}
                          </div>
                          <div>
                            <span className="text-sm muted">Execution record</span>
                            <div className="mt-1">
                              {decision.execution ? (
                                <Badge
                                  variant={
                                    decision.execution.status === 'OPEN' ||
                                    decision.execution.status === 'CLOSED'
                                      ? 'success'
                                      : decision.execution.status === 'REJECTED'
                                        ? 'error'
                                        : 'info'
                                  }
                                >
                                  {formatEnumLabel(decision.execution.status)}
                                </Badge>
                              ) : (
                                <span>Not available</span>
                              )}
                            </div>
                            {decision.execution?.closeReason && (
                              <p className="text-sm mt-2">
                                Close reason: {formatEnumLabel(decision.execution.closeReason)}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="mt-4">
                          <span className="text-sm muted">Persisted lifecycle</span>
                          <ol
                            className="mt-2"
                            style={{
                              display: 'grid',
                              gap: 'var(--space-2)',
                              marginBottom: 0,
                              paddingLeft: '1.25rem',
                            }}
                          >
                            {decision.timeline.map((entry, index) => (
                              <li key={`${decision.signalId}-${entry.at}-${index}`}>
                                <strong>{formatEnumLabel(entry.stage)}</strong>
                                {' · '}
                                {formatEnumLabel(entry.status)}
                                {entry.code ? ` · ${formatEnumLabel(entry.code)}` : ''}
                                {' — '}
                                {entry.message}
                                <span className="text-sm muted"> · {formatTimestamp(entry.at)}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </Card>
            </section>

            <div className="mt-4">
              <Alert variant="info">
                This page is an evidence viewer, not a model-thought viewer. Agent Council context contains only concise accepted evidence and explicit consensus state. Opaque AI metadata, chain-of-thought, provider metadata, raw risk context, credentials, financial calculations, and internal error payloads are intentionally excluded.
              </Alert>
            </div>
          </>
        ) : null}
      </main>
    </DashboardShell>
  );
}
