'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Card,
  DashboardShell,
  Input,
  LoadingSpinner,
} from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';
import type { AdvancedAiControlsResponse } from '@irexpro/api-client';

type GateMetric = {
  label: string;
  observedKey: string;
  thresholdKey: string;
  format: (value: number) => string;
  scaleMax: (observed: number, threshold: number) => number;
  lowerIsBetter?: boolean;
};

const GATE_METRICS: GateMetric[] = [
  {
    label: 'Balanced accuracy',
    observedKey: 'balanced_accuracy',
    thresholdKey: 'min_balanced_accuracy',
    format: (value) => value.toFixed(3),
    scaleMax: () => 1,
  },
  {
    label: 'Sharpe ratio',
    observedKey: 'sharpe_ratio',
    thresholdKey: 'min_sharpe_ratio',
    format: (value) => value.toFixed(2),
    scaleMax: (observed, threshold) => Math.max(3, observed * 1.1, threshold * 2),
  },
  {
    label: 'Profit factor',
    observedKey: 'profit_factor',
    thresholdKey: 'min_profit_factor',
    format: (value) => value.toFixed(2),
    scaleMax: (observed, threshold) => Math.max(3, observed * 1.1, threshold * 2),
  },
  {
    label: 'Max drawdown',
    observedKey: 'max_drawdown',
    thresholdKey: 'max_drawdown',
    format: (value) => `${(value * 100).toFixed(2)}%`,
    scaleMax: (_observed, threshold) => Math.max(0.2, threshold * 1.25),
    lowerIsBetter: true,
  },
  {
    label: 'Positive fold fraction',
    observedKey: 'positive_fold_fraction',
    thresholdKey: 'min_positive_fold_fraction',
    format: (value) => `${(value * 100).toFixed(1)}%`,
    scaleMax: () => 1,
  },
  {
    label: 'Positive instrument fraction',
    observedKey: 'positive_instrument_fraction',
    thresholdKey: 'min_positive_instrument_fraction',
    format: (value) => `${(value * 100).toFixed(1)}%`,
    scaleMax: () => 1,
  },
];

function QualificationBar({
  metric,
  observed,
  threshold,
}: {
  metric: GateMetric;
  observed: number;
  threshold: number;
}) {
  const max = metric.scaleMax(observed, threshold);
  const observedPct = Math.max(0, Math.min(100, (observed / max) * 100));
  const thresholdPct = Math.max(0, Math.min(100, (threshold / max) * 100));
  const passed = metric.lowerIsBetter ? observed <= threshold : observed >= threshold;

  return (
    <div className="workspace-form-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline' }}>
        <strong>{metric.label}</strong>
        <Badge variant={passed ? 'success' : 'error'}>{passed ? 'PASS' : 'FAIL'}</Badge>
      </div>
      <div
        aria-label={`${metric.label}: observed ${metric.format(observed)}, required ${metric.format(threshold)}`}
        style={{
          position: 'relative',
          height: '12px',
          borderRadius: '999px',
          background: 'var(--surface-muted, rgba(127,127,127,.18))',
          overflow: 'hidden',
          marginTop: '0.75rem',
        }}
      >
        <div
          style={{
            width: `${observedPct}%`,
            height: '100%',
            background: 'var(--brand)',
          }}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `calc(${thresholdPct}% - 1px)`,
            top: 0,
            width: '2px',
            height: '100%',
            background: 'currentColor',
            opacity: 0.75,
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.45rem', gap: '1rem' }}>
        <span className="muted text-sm">Observed: {metric.format(observed)}</span>
        <span className="muted text-sm">
          {metric.lowerIsBetter ? 'Maximum' : 'Minimum'}: {metric.format(threshold)}
        </span>
      </div>
    </div>
  );
}

export default function AdvancedAiControlsPage() {
  const { user, logout, restoring } = useAuth();
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);
  const [controls, setControls] = useState<AdvancedAiControlsResponse | null>(null);
  const [confidencePercent, setConfidencePercent] = useState(60);
  const [unlocking, setUnlocking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring session…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '680px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to access Advanced AI Controls.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  const unlock = async () => {
    setError(null);
    setSaved(false);
    setUnlocking(true);
    try {
      const auth = await api.stepUpAdvancedAiControls({
        password,
        mfaCode: user.mfaEnabled ? mfaCode.trim() || undefined : undefined,
        riskAcknowledged: true,
      });
      const next = await api.getAdvancedAiControls(auth.stepUpToken);
      setStepUpToken(auth.stepUpToken);
      setControls(next);
      setConfidencePercent(Math.round(next.controls.executionConfidenceFloor * 100));
      setPassword('');
      setMfaCode('');
    } catch (requestError) {
      setError(mapApiError(requestError).message);
    } finally {
      setUnlocking(false);
    }
  };

  const save = async () => {
    if (!stepUpToken) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const next = await api.updateAdvancedAiControls(stepUpToken, {
        executionConfidenceFloor: confidencePercent / 100,
      });
      setControls(next);
      setSaved(true);
    } catch (requestError) {
      setError(mapApiError(requestError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardShell
      user={user}
      onLogout={logout}
      activeRoute="/settings/advanced-ai"
      title="Advanced AI Controls"
    >
      <main className="workspace-page" aria-labelledby="advanced-ai-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Protected research controls</p>
            <h1 id="advanced-ai-title" className="workspace-hero__title">Advanced AI Controls</h1>
            <p className="workspace-hero__description">
              Inspect the active model&apos;s qualification evidence and adjust only controls that have the same meaning and enforcement path in Demo, PAPER and LIVE.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={stepUpToken ? 'success' : 'warning'}>
              {stepUpToken ? 'STEP-UP VERIFIED' : 'LOCKED'}
            </Badge>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}
        {saved && (
          <Alert variant="success">
            Execution preference saved. It will apply consistently to the next Demo, PAPER or LIVE scheduler session.
          </Alert>
        )}

        {!stepUpToken || !controls ? (
          <Card
            title="Re-authentication required"
            subtitle="Advanced controls stay locked until you acknowledge the risk and prove your identity again."
          >
            <Alert variant="warning">
              <div className="responsive-copy-split">
                <strong>Changing execution AI controls can materially change trade frequency, drawdown, and losses in every execution mode.</strong>
                <span>
                  These controls do not change model qualification results and do not guarantee profitability. No setting on this page may weaken the active model&apos;s qualified production floor.
                </span>
              </div>
            </Alert>

            <label style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginTop: '1rem' }}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                style={{ marginTop: '0.2rem' }}
              />
              <span>
                I understand that these controls are designed to promote unchanged to LIVE, can alter trade frequency and losses, and I want to continue.
              </span>
            </label>

            <div className="workspace-grid-2 mt-4">
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {user.mfaEnabled ? (
                <Input
                  label="Authenticator code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              ) : (
                <div className="workspace-form-section">
                  <span className="input-label">Second factor</span>
                  <span className="muted text-sm">
                    MFA is not enabled. You can enable it from Security for stronger step-up protection.
                  </span>
                </div>
              )}
            </div>

            <div className="workspace-actions mt-4">
              <Button
                type="button"
                variant="primary"
                loading={unlocking}
                disabled={!acknowledged || password.length < 8 || (user.mfaEnabled && mfaCode.length !== 6)}
                onClick={() => void unlock()}
              >
                Verify & Open Advanced Controls
              </Button>
              <Link href="/security" className="btn btn--secondary">Security settings</Link>
            </div>
          </Card>
        ) : (
          <>
            <Alert variant="info">
              Qualification gates below are <strong>read-only evidence</strong>. They are owned by the
              model qualification process and cannot be weakened from this page.
            </Alert>

            <Card
              title="Active model qualification"
              subtitle={controls.modelQualification?.modelVersion ?? 'Qualification evidence unavailable'}
            >
              {controls.modelQualification ? (
                <div className="workspace-grid-2">
                  {GATE_METRICS.map((metric) => {
                    const observed = controls.modelQualification!.observed[metric.observedKey];
                    const threshold = controls.modelQualification!.thresholds[metric.thresholdKey];
                    if (typeof observed !== 'number' || typeof threshold !== 'number') return null;
                    return (
                      <QualificationBar
                        key={metric.observedKey}
                        metric={metric}
                        observed={observed}
                        threshold={threshold}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="muted">
                  The AI engine did not return qualification evidence for the currently loaded model.
                </p>
              )}
            </Card>

            <Card
              title="Execution confidence"
              subtitle="Same setting and server enforcement in Demo, PAPER and LIVE. It cannot be set below the active qualified production floor."
            >
              <div className="workspace-form-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>Confidence floor</strong>
                  <strong>{confidencePercent}%</strong>
                </div>
                <input
                  type="range"
                  min={Math.round(controls.controls.executionConfidenceMin * 100)}
                  max={Math.round(controls.controls.executionConfidenceMax * 100)}
                  step={1}
                  value={confidencePercent}
                  onChange={(event) => setConfidencePercent(Number(event.target.value))}
                  style={{ width: '100%', marginTop: '1rem' }}
                  aria-label="Execution confidence floor"
                />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted text-sm">60% qualified minimum</span>
                  <span className="muted text-sm">70% maximum</span>
                </div>
              </div>

              <Alert variant="warning">
                The active qualified minimum is{' '}
                <strong>{Math.round(controls.controls.qualifiedMinimumConfidence * 100)}%</strong>.
                Demo, PAPER and LIVE all use this same user preference and the same lower bound.
              </Alert>

              <div className="workspace-actions mt-4">
                <Button type="button" variant="primary" loading={saving} onClick={() => void save()}>
                  Save Execution Preference
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setStepUpToken(null);
                    setControls(null);
                    setAcknowledged(false);
                    setSaved(false);
                  }}
                >
                  Lock controls
                </Button>
              </div>
            </Card>
          </>
        )}
      </main>
    </DashboardShell>
  );
}
