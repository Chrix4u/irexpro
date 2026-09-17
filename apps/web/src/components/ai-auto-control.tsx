'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CapitalBudgetView, TradingSessionView } from '@irexpro/types/execution';
import { Alert, Badge, Button, Card } from '@/components/ui';
import { useNotification } from '@/hooks/useNotification';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';
import './ai-auto-control.css';

export interface AiAutoBroker {
  id: string;
  brokerName: string;
  displayName?: string | null;
  accountType: 'DEMO' | 'LIVE';
  status: string;
  liveTradingEnabled?: boolean;
}

export interface AiAutoControlProps {
  broker: AiAutoBroker | null;
  session: TradingSessionView | null;
  onChanged?: () => void | Promise<void>;
}

function money(currency: string | undefined, value: string | undefined): string {
  if (!currency || value === undefined) return '—';
  return `${currency} ${value}`;
}

export function AiAutoControl({ broker, session, onChanged }: AiAutoControlProps) {
  const notify = useNotification();
  const [budget, setBudget] = useState<CapitalBudgetView | null>(null);
  const [allocationInput, setAllocationInput] = useState('');
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [savingAllocation, setSavingAllocation] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiOn = Boolean(
    broker &&
    session &&
    session.brokerConnectionId === broker.id &&
    session.status === 'ACTIVE',
  );

  const desiredMode = broker?.accountType === 'LIVE' ? 'FULL_AUTO' : 'PAPER_ONLY';

  const loadBudget = useCallback(async () => {
    if (!broker) {
      setBudget(null);
      setAllocationInput('');
      return;
    }
    setLoadingBudget(true);
    setError(null);
    try {
      const next = await api.getCapitalBudget(broker.id);
      setBudget(next);
      setAllocationInput(next.configured ? next.totalCapital : '');
    } catch (requestError) {
      setBudget(null);
      setError(mapApiError(requestError).message);
    } finally {
      setLoadingBudget(false);
    }
  }, [broker]);

  useEffect(() => {
    void loadBudget();
  }, [loadBudget]);

  const allocationReady = Boolean(budget?.configured && budget.totalCapital !== '0');
  const brokerReady = broker?.status === 'CONNECTED';

  const helper = useMemo(() => {
    if (!broker) return 'Connect a broker account first.';
    if (!brokerReady) return 'The broker must be connected before AI automation can start.';
    if (!allocationReady) return 'Choose how much broker equity the AI may use, then switch AI Auto on.';
    if (aiOn) return 'AI Auto is active. New exposure remains subject to server-managed protection on every decision.';
    return 'Allocation is ready. Switch AI Auto on when you want the engine to begin autonomous trading.';
  }, [broker, brokerReady, allocationReady, aiOn]);

  async function saveAllocation() {
    if (!broker || !allocationInput.trim()) return;
    setSavingAllocation(true);
    setError(null);
    try {
      const next = await api.updateCapitalBudget({
        brokerConnectionId: broker.id,
        totalCapital: allocationInput.trim(),
      });
      setBudget(next);
      setAllocationInput(next.totalCapital);
      notify.success(`AI allocation saved: ${money(next.accountCurrency, next.totalCapital)}.`);
      await onChanged?.();
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setSavingAllocation(false);
    }
  }

  async function toggleAutomation() {
    if (!broker || toggling) return;
    setError(null);
    setToggling(true);
    try {
      if (aiOn && session) {
        await api.stopTradingSession(session.id);
        notify.info('AI Auto is off. Existing broker positions are not force-closed.');
        await onChanged?.();
        return;
      }

      if (!budget?.configured || budget.totalCapital === '0') {
        notify.warning('Allocate capital before switching AI Auto on.');
        return;
      }
      if (broker.status !== 'CONNECTED') {
        notify.warning('Connect the broker before switching AI Auto on.');
        return;
      }

      // The single visible AI Auto action is the user's explicit automation
      // authorization. Existing server gates still independently validate
      // mode eligibility, provider state, risk limits and final dispatch.
      await api.updateRiskProfile({ allowedTradingModes: desiredMode });
      if (broker.accountType === 'LIVE' && !broker.liveTradingEnabled) {
        await api.enableLiveTrading(broker.id);
      }

      if (session && session.status !== 'ENDED') {
        if (session.brokerConnectionId !== broker.id || session.status !== 'ACTIVE') {
          await api.stopTradingSession(session.id);
          await api.startTradingSession({ brokerConnectionId: broker.id, executionMode: desiredMode });
        } else if (session.executionMode !== desiredMode) {
          await api.changeTradingSessionMode(session.id, { executionMode: desiredMode });
        }
      } else {
        await api.startTradingSession({ brokerConnectionId: broker.id, executionMode: desiredMode });
      }

      notify.success(`${broker.accountType === 'LIVE' ? 'Live' : 'Paper/demo'} AI Auto is on.`);
      await onChanged?.();
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setToggling(false);
    }
  }

  return (
    <Card className="ai-auto-card">
      <div className="ai-auto-head">
        <div>
          <p className="ai-auto-eyebrow">AI Auto Trader</p>
          <h2>Allocate. Switch on. AI handles the rest.</h2>
          <p className="muted">{helper}</p>
        </div>
        <button
          type="button"
          className={`ai-auto-switch${aiOn ? ' ai-auto-switch--on' : ''}`}
          role="switch"
          aria-checked={aiOn}
          aria-label="AI Auto"
          disabled={!broker || toggling}
          onClick={() => void toggleAutomation()}
        >
          <span className="ai-auto-switch__track"><span className="ai-auto-switch__thumb" /></span>
          <span>{toggling ? 'Updating…' : aiOn ? 'AI Auto ON' : 'AI Auto OFF'}</span>
        </button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {!broker ? (
        <div className="ai-auto-empty">
          <p className="muted">No broker is available for automation.</p>
          <a href="/onboarding/broker" className="btn btn--primary btn--sm">Connect broker</a>
        </div>
      ) : (
        <>
          <div className="ai-auto-broker-row">
            <div>
              <strong>{broker.displayName ?? broker.brokerName}</strong>
              <span>{broker.accountType === 'LIVE' ? 'Live broker account' : 'Demo / simulated account'}</span>
            </div>
            <div className="ai-auto-badges">
              <Badge variant={broker.status === 'CONNECTED' ? 'success' : 'warning'}>{broker.status}</Badge>
              <Badge variant={broker.accountType === 'LIVE' ? 'warning' : 'info'}>{broker.accountType}</Badge>
            </div>
          </div>

          <div className="ai-auto-metrics" aria-label="AI capital allocation">
            <div><span>Broker equity</span><strong>{loadingBudget ? 'Loading…' : money(budget?.accountCurrency, budget?.authoritativeEquity)}</strong></div>
            <div><span>AI allocation</span><strong>{budget?.configured ? money(budget.accountCurrency, budget.totalCapital) : 'Not allocated'}</strong></div>
            <div><span>Committed</span><strong>{budget?.configured ? money(budget.accountCurrency, budget.committedCapital) : '—'}</strong></div>
            <div><span>Available to AI</span><strong>{budget?.configured ? money(budget.accountCurrency, budget.availableCapital) : '—'}</strong></div>
          </div>

          <div className="ai-auto-allocation">
            <label htmlFor={`ai-allocation-${broker.id}`}>Capital allocation</label>
            <div className="ai-auto-allocation__controls">
              <div className="ai-auto-money-input">
                <span>{budget?.accountCurrency ?? '—'}</span>
                <input
                  id={`ai-allocation-${broker.id}`}
                  value={allocationInput}
                  onChange={(event) => setAllocationInput(event.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 2500.00"
                  disabled={loadingBudget || savingAllocation}
                  aria-describedby={`ai-allocation-help-${broker.id}`}
                />
              </div>
              <Button type="button" variant="secondary" disabled={!budget || savingAllocation} onClick={() => budget && setAllocationInput(budget.authoritativeEquity)}>
                Use full equity
              </Button>
              <Button type="button" loading={savingAllocation} disabled={!allocationInput.trim() || savingAllocation} onClick={() => void saveAllocation()}>
                Save allocation
              </Button>
            </div>
            <p id={`ai-allocation-help-${broker.id}`} className="text-sm muted">
              This is the maximum broker capital the AI is authorized to commit. It never increases automatically with account equity.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}

export default AiAutoControl;
