'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaymentProviderInfo } from '@irexpro/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DashboardShell,
  EmptyState,
  LoadingSpinner,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/notifications/ConfirmDialog';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';

type AssessmentStatus = 'DRAFT' | 'ASSESSED' | 'INVOICED' | 'WAIVED' | 'PAID' | 'CANCELLED';
type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID' | 'OVERDUE' | 'CANCELLED';

interface PerformanceSummary {
  performance: {
    currency: string;
    currentHighWaterMark: string;
    totalRealisedProfit: string;
    totalFeesCharged: string;
    lastCalculationAt: string | null;
  } | null;
  assessments: Array<{
    id: string;
    currency: string;
    periodStart: string;
    periodEnd: string;
    realisedProfitForFee: string;
    feePercent: string;
    feeAmount: string;
    status: AssessmentStatus;
    invoiceId: string | null;
  }>;
}

interface PerformanceInvoice {
  invoiceId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: string;
  dueDate: string | null;
  paidAt: string | null;
  paymentStatus: string;
  provider: string | null;
  createdAt: string;
}

interface CheckoutResult {
  provider: string;
  checkoutUrl?: string;
  reusedExistingSession: boolean;
}

interface SimulationCharge {
  id: string;
  sourceMode: 'PAPER' | 'DEMO';
  currency: string;
  tradeCount: number;
  startingHighWaterMark: string;
  endingRealisedBalance: string;
  realisedProfitForFee: string;
  feePercent: string;
  feeAmount: string;
  status: 'DUE_TEST' | 'SETTLED_TEST' | 'CANCELLED';
  simulatedSettledAt: string | null;
  createdAt: string;
}

interface FeeSimulationAccount {
  brokerConnectionId: string;
  brokerId: string;
  brokerName: string;
  displayName: string | null;
  sourceMode: 'PAPER' | 'DEMO';
  currency: string;
  simulationActive: boolean;
  simulationStartedAt: string | null;
  closedTradeCount: number;
  firstClosedAt: string | null;
  lastClosedAt: string | null;
  cumulativeRealisedMinor: string;
  currentHighWaterMarkMinor: string;
  profitAboveHighWaterMarkMinor: string;
  currentSimulatedFeeMinor: string;
  totalFeesSimulatedMinor: string;
  policy: {
    id: string;
    name: string;
    feePercent: string;
    billingFrequency: string;
    calculationMode: string;
  } | null;
  currentCharge: SimulationCharge | null;
  recentCharges: SimulationCharge[];
  nonPayable: true;
}

interface FeeSimulationResponse {
  mode: 'TEST_ONLY';
  paymentEnabled: false;
  accounts: FeeSimulationAccount[];
}

function minorDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (['JPY', 'KRW'].includes(code)) return 0;
  if (['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(code)) return 3;
  return 2;
}

function money(minor: string | null | undefined, currency: string | null | undefined): string {
  if (minor == null || !currency) return '—';
  try {
    const value = BigInt(minor);
    const digits = minorDigits(currency);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    if (digits === 0) return `${negative ? '-' : ''}${absolute.toString()} ${currency}`;
    const base = 10n ** BigInt(digits);
    const major = absolute / base;
    const fraction = (absolute % base).toString().padStart(digits, '0');
    return `${negative ? '-' : ''}${major.toString()}.${fraction} ${currency}`;
  } catch {
    return '—';
  }
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function invoiceVariant(status: InvoiceStatus): 'success' | 'error' | 'warning' | 'info' {
  if (status === 'PAID') return 'success';
  if (status === 'OVERDUE') return 'error';
  if (status === 'ISSUED') return 'warning';
  return 'info';
}

export default function PaymentsPage() {
  const { user, logout, restoring } = useAuth();
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [invoices, setInvoices] = useState<PerformanceInvoice[]>([]);
  const [providers, setProviders] = useState<PaymentProviderInfo[]>([]);
  const [simulation, setSimulation] = useState<FeeSimulationResponse | null>(null);
  const [simulationBusyId, setSimulationBusyId] = useState<string | null>(null);
  const [settleCharge, setSettleCharge] = useState<{
    account: FeeSimulationAccount;
    charge: SimulationCharge;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checkoutInvoice, setCheckoutInvoice] = useState<PerformanceInvoice | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [notice, setNotice] = useState<{ variant: 'success' | 'error' | 'info'; message: string } | null>(null);

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setNotice(null);
    try {
      const [nextSummary, nextInvoices, nextProviders, nextSimulation] = await Promise.all([
        api.request<PerformanceSummary>('/performance-fees/me/summary'),
        api.request<PerformanceInvoice[]>('/performance-fees/invoices'),
        api.listProviders(),
        api.request<FeeSimulationResponse>('/performance-fees/me/simulation'),
      ]);
      setSummary(nextSummary);
      setInvoices(nextInvoices);
      setProviders(nextProviders);
      setSimulation(nextSimulation);
    } catch (error) {
      setNotice({
        variant: 'error',
        message: error instanceof Error ? error.message : 'Fees and payment information could not be loaded.',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [load, user]);

  const liveProviders = useMemo(() => providers.filter((provider) => provider.isLive), [providers]);
  const payable = useMemo(
    () => invoices.filter((invoice) => invoice.status === 'ISSUED' || invoice.status === 'OVERDUE'),
    [invoices],
  );
  const latestAssessment = summary?.assessments?.[0] ?? null;

  async function runSimulation(account: FeeSimulationAccount): Promise<void> {
    if (simulationBusyId) return;
    setSimulationBusyId(account.brokerConnectionId);
    setNotice(null);
    try {
      await api.request(
        `/performance-fees/me/simulation/${encodeURIComponent(account.brokerConnectionId)}/refresh`,
        { method: 'POST' },
      );
      setNotice({
        variant: 'success',
        message:
          'PAPER/DEMO fee simulation refreshed. This is test-only and cannot create a real payment obligation.',
      });
      await load(true);
    } catch (error) {
      setNotice({
        variant: 'error',
        message: error instanceof Error ? error.message : 'Fee simulation could not be refreshed.',
      });
    } finally {
      setSimulationBusyId(null);
    }
  }

  async function settleSimulation(): Promise<void> {
    if (!settleCharge || simulationBusyId) return;
    const target = settleCharge;
    setSimulationBusyId(target.charge.id);
    setNotice(null);
    try {
      await api.request(
        `/performance-fees/me/simulation/charges/${encodeURIComponent(target.charge.id)}/settle`,
        { method: 'POST' },
      );
      setSettleCharge(null);
      setNotice({
        variant: 'success',
        message:
          'Test settlement recorded. No money moved; the simulated high-water mark advanced exactly as LIVE would after verified payment.',
      });
      await load(true);
    } catch (error) {
      setNotice({
        variant: 'error',
        message: error instanceof Error ? error.message : 'Test settlement could not be recorded.',
      });
    } finally {
      setSimulationBusyId(null);
    }
  }

  async function beginCheckout(): Promise<void> {
    if (!checkoutInvoice || checkoutBusy) return;
    const invoice = checkoutInvoice;
    setCheckoutBusy(true);
    setNotice(null);
    try {
      const result = await api.request<CheckoutResult>(
        `/performance-fees/invoices/${encodeURIComponent(invoice.invoiceId)}/checkout`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      );
      if (!result.checkoutUrl) {
        setNotice({
          variant: 'info',
          message: 'The provider session exists, but no browser checkout URL was returned. The invoice remains unpaid.',
        });
        setCheckoutInvoice(null);
        await load(true);
        return;
      }
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      setNotice({
        variant: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Secure checkout could not be started. The invoice remains unchanged.',
      });
      setCheckoutInvoice(null);
    } finally {
      setCheckoutBusy(false);
    }
  }

  if (restoring || (user && loading)) return <LoadingSpinner text="Loading fees and payments…" />;

  if (!user) {
    return (
      <main style={{ maxWidth: 680, margin: '4rem auto', padding: '1rem' }}>
        <Card title="Sign in required">
          <p className="muted">Sign in to review your performance-fee position and invoices.</p>
        </Card>
      </main>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/payments" title="Fees & Payments">
      <main className="workspace-page" aria-labelledby="fees-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Billing & settlement</p>
            <h1 id="fees-title" className="workspace-hero__title">Fees & Payments</h1>
            <p className="workspace-hero__description">
              iRexPro charges performance fees only on qualifying realised LIVE-trading profit above
              the high-water mark. Deposits, paper/demo results and unrealised P&amp;L are excluded.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Button variant="secondary" size="sm" loading={refreshing} onClick={() => void load(true)}>
              Refresh
            </Button>
          </div>
        </section>

        {notice ? <Alert variant={notice.variant}>{notice.message}</Alert> : null}

        <Card
          title="PAPER / DEMO fee simulation"
          subtitle="Exercises the same high-water-mark fee formula without creating a real invoice, debt or payment transaction."
        >
          <Alert variant="warning">
            TEST MODE ONLY — PAPER/DEMO charges are non-payable. “Simulate settlement” moves no
            money; it only advances the test high-water mark so we can verify the next fee cycle.
          </Alert>

          {(simulation?.accounts ?? []).length === 0 ? (
            <EmptyState
              title="No PAPER/DEMO account available"
              description="Connect a PAPER or DEMO broker account to test performance-fee charging."
            />
          ) : (
            <div className="workspace-form-section" style={{ marginTop: '1rem' }}>
              {simulation!.accounts.map((account) => (
                <div
                  key={account.brokerConnectionId}
                  className="card"
                  style={{ margin: 0, padding: '1rem' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <strong>{account.displayName ?? account.brokerName}</strong>
                      <div className="muted text-sm" style={{ marginTop: '0.25rem' }}>
                        {account.closedTradeCount} closed trades · last close{' '}
                        {shortDate(account.lastClosedAt)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Badge variant="warning">{account.sourceMode}</Badge>
                      <Badge variant="info">TEST · NON-PAYABLE</Badge>
                    </div>
                  </div>

                  <div className="workspace-grid-3" style={{ marginTop: '1rem' }}>
                    <div className="workspace-metric">
                      <span className="workspace-metric__label">Realised P&amp;L</span>
                      <strong className="workspace-metric__value">
                        {money(account.cumulativeRealisedMinor, account.currency)}
                      </strong>
                      <span className="workspace-metric__hint">Closed PAPER/DEMO trades only.</span>
                    </div>
                    <div className="workspace-metric">
                      <span className="workspace-metric__label">Simulated HWM</span>
                      <strong className="workspace-metric__value">
                        {money(account.currentHighWaterMarkMinor, account.currency)}
                      </strong>
                      <span className="workspace-metric__hint">
                        {account.simulationActive
                          ? `Test baseline started ${shortDate(account.simulationStartedAt)}; advances after simulated settlement.`
                          : 'Will baseline at the current realised P&L when the test starts.'}
                      </span>
                    </div>
                    <div className="workspace-metric">
                      <span className="workspace-metric__label">Would charge now</span>
                      <strong className="workspace-metric__value">
                        {!account.simulationActive
                          ? 'Not started'
                          : account.policy
                            ? money(account.currentSimulatedFeeMinor, account.currency)
                            : 'Policy required'}
                      </strong>
                      <span className="workspace-metric__hint">
                        Fee basis {money(account.profitAboveHighWaterMarkMinor, account.currency)}
                        {account.policy
                          ? ` · ${Number(account.policy.feePercent).toFixed(2)}%`
                          : ''}
                      </span>
                    </div>
                  </div>

                  {account.policy ? (
                    <Alert variant="info">
                      Policy: <strong>{account.policy.name}</strong> ·{' '}
                      {Number(account.policy.feePercent).toFixed(2)}% ·{' '}
                      {account.policy.billingFrequency.replaceAll('_', ' ')}. The simulator and LIVE
                      engine share the same integer high-water-mark calculation.
                    </Alert>
                  ) : (
                    <Alert variant="warning">
                      No active performance-fee policy is configured. An admin must set the rate
                      before a simulated charge can be created.
                    </Alert>
                  )}

                  {account.currentCharge ? (
                    <div
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '1rem',
                        marginTop: '0.9rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: '1rem',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div>
                          <div className="muted text-sm">TEST INVOICE</div>
                          <strong>
                            {money(account.currentCharge.feeAmount, account.currency)}
                          </strong>
                          <div className="muted text-sm">
                            Basis{' '}
                            {money(account.currentCharge.realisedProfitForFee, account.currency)} ·{' '}
                            {Number(account.currentCharge.feePercent).toFixed(2)}%
                          </div>
                        </div>
                        <Badge variant="warning">DUE TEST · NO PAYMENT</Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={simulationBusyId === account.currentCharge.id}
                        disabled={Boolean(simulationBusyId)}
                        onClick={() =>
                          setSettleCharge({ account, charge: account.currentCharge! })
                        }
                        style={{ marginTop: '0.8rem' }}
                      >
                        Simulate settlement
                      </Button>
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: 'flex',
                      gap: '0.75rem',
                      marginTop: '1rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Button
                      size="sm"
                      loading={simulationBusyId === account.brokerConnectionId}
                      disabled={Boolean(simulationBusyId) || !account.policy}
                      onClick={() => void runSimulation(account)}
                    >
                      {account.simulationActive
                        ? 'Run fee simulation'
                        : 'Start fee simulation'}
                    </Button>
                    <span className="muted text-sm" style={{ alignSelf: 'center' }}>
                      Total simulated fees:{' '}
                      {money(account.totalFeesSimulatedMinor, account.currency)}
                    </span>
                  </div>

                  {account.recentCharges.length > 0 ? (
                    <div style={{ marginTop: '1rem' }}>
                      <div className="muted text-sm" style={{ marginBottom: '0.5rem' }}>
                        Recent test charge cycles
                      </div>
                      <div className="payments-table-scroll">
                        <table className="payments-table" aria-label="Simulated fee charge history">
                          <thead>
                            <tr>
                              <th>Created</th>
                              <th>Fee basis</th>
                              <th>Test fee</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {account.recentCharges.slice(0, 5).map((charge) => (
                              <tr key={charge.id}>
                                <td>{shortDate(charge.createdAt)}</td>
                                <td>
                                  {money(charge.realisedProfitForFee, account.currency)}
                                </td>
                                <td>{money(charge.feeAmount, account.currency)}</td>
                                <td>
                                  <Badge
                                    variant={
                                      charge.status === 'SETTLED_TEST' ? 'success' : 'warning'
                                    }
                                  >
                                    {charge.status.replaceAll('_', ' ')}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>

        <section className="workspace-grid-3" aria-label="Performance fee summary">
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">High-water mark</span>
              <strong className="workspace-metric__value">
                {money(summary?.performance?.currentHighWaterMark, summary?.performance?.currency)}
              </strong>
              <span className="workspace-metric__hint">Previously fee-settled profit threshold.</span>
            </div>
          </Card>
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">Realised profit tracked</span>
              <strong className="workspace-metric__value">
                {money(summary?.performance?.totalRealisedProfit, summary?.performance?.currency)}
              </strong>
              <span className="workspace-metric__hint">Closed LIVE trades only.</span>
            </div>
          </Card>
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">Fees settled</span>
              <strong className="workspace-metric__value">
                {money(summary?.performance?.totalFeesCharged, summary?.performance?.currency)}
              </strong>
              <span className="workspace-metric__hint">Provider-webhook-confirmed payments.</span>
            </div>
          </Card>
        </section>

        <section className="workspace-grid-2">
          <Card title="How the fee works" subtitle="No automatic broker withdrawal is performed.">
            <div className="workspace-form-section">
              <p><strong>1.</strong> Only realised profit from closed LIVE trades enters the fee ledger.</p>
              <p><strong>2.</strong> New realised profit is compared with the existing high-water mark.</p>
              <p><strong>3.</strong> A fee is calculated only on qualifying profit above that mark.</p>
              <p><strong>4.</strong> The platform issues an invoice instead of taking funds from the broker.</p>
              <p><strong>5.</strong> Only a verified provider webhook can mark that invoice paid.</p>
            </div>
          </Card>

          <Card title="Payment readiness" subtitle="Checkout appears only when a production provider is live.">
            <div className="workspace-metric">
              <span className="workspace-metric__label">Available production providers</span>
              <strong className="workspace-metric__value">{liveProviders.length}</strong>
              <span className="workspace-metric__hint">
                {liveProviders.length
                  ? liveProviders.map((provider) => provider.displayName).join(', ')
                  : 'Online fee checkout is currently disabled; invoices remain reviewable.'}
              </span>
            </div>
            {liveProviders.length === 0 ? (
              <Alert variant="info">
                No production payment provider is enabled yet. No local action can mark an invoice paid.
              </Alert>
            ) : null}
          </Card>
        </section>

        <Card
          title="Outstanding invoices"
          subtitle={payable.length ? 'Server-issued performance-fee invoices awaiting settlement.' : 'Nothing is currently due.'}
        >
          {payable.length === 0 ? (
            <EmptyState title="No fees due" description="There are no issued or overdue performance-fee invoices." />
          ) : (
            <div className="payments-table-scroll">
              <table className="payments-table" aria-label="Outstanding performance fee invoices">
                <thead>
                  <tr><th>Invoice</th><th>Amount</th><th>Status</th><th>Due</th><th>Provider</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {payable.map((invoice) => (
                    <tr key={invoice.invoiceId}>
                      <td>
                        <strong>{invoice.invoiceNumber}</strong>
                        <div className="muted text-sm">Issued {shortDate(invoice.createdAt)}</div>
                      </td>
                      <td><strong>{money(invoice.totalAmount, invoice.currency)}</strong></td>
                      <td><Badge variant={invoiceVariant(invoice.status)}>{invoice.status}</Badge></td>
                      <td>{shortDate(invoice.dueDate)}</td>
                      <td>{invoice.provider ?? 'Not selected'}</td>
                      <td>
                        <Button
                          size="sm"
                          disabled={liveProviders.length === 0 || checkoutBusy}
                          onClick={() => setCheckoutInvoice(invoice)}
                        >
                          {invoice.paymentStatus === 'PROCESSING' ? 'Continue payment' : 'Pay securely'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <section className="workspace-grid-2">
          <Card title="Recent assessments" subtitle="Newest fee periods first.">
            {(summary?.assessments ?? []).length === 0 ? (
              <EmptyState title="No fee assessments yet" />
            ) : (
              <div className="workspace-form-section">
                {summary!.assessments.slice(0, 5).map((assessment) => (
                  <div className="workspace-metric" key={assessment.id}>
                    <span className="workspace-metric__label">
                      {shortDate(assessment.periodStart)} – {shortDate(assessment.periodEnd)}
                    </span>
                    <strong>{money(assessment.feeAmount, assessment.currency)}</strong>
                    <span className="workspace-metric__hint">
                      Basis {money(assessment.realisedProfitForFee, assessment.currency)} ·{' '}
                      {Number(assessment.feePercent).toFixed(2)}% · {assessment.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Payment history" subtitle="Newest performance-fee invoices first.">
            {invoices.length === 0 ? (
              <EmptyState title="No invoices yet" />
            ) : (
              <div className="workspace-form-section">
                {invoices.slice(0, 8).map((invoice) => (
                  <div className="workspace-metric" key={invoice.invoiceId}>
                    <span className="workspace-metric__label">
                      {invoice.invoiceNumber} · {shortDate(invoice.createdAt)}
                    </span>
                    <strong>{money(invoice.totalAmount, invoice.currency)}</strong>
                    <span className="workspace-metric__hint">
                      {invoice.status} · payment {invoice.paymentStatus} · {invoice.provider ?? 'provider not selected'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>

        {latestAssessment ? (
          <Alert variant="info">
            Latest assessment rate: {Number(latestAssessment.feePercent).toFixed(2)}%. The server-side
            policy recorded on each assessment is authoritative.
          </Alert>
        ) : null}
      </main>

      <ConfirmDialog
        open={settleCharge !== null}
        title="Simulate fee settlement?"
        description={
          settleCharge
            ? `Record a TEST settlement of ${money(
                settleCharge.charge.feeAmount,
                settleCharge.account.currency,
              )}. No payment provider is contacted and no money moves. This only advances the PAPER/DEMO high-water mark to ${money(
                settleCharge.charge.endingRealisedBalance,
                settleCharge.account.currency,
              )} so the next charge cycle can be tested.`
            : ''
        }
        confirmLabel={
          settleCharge && simulationBusyId === settleCharge.charge.id
            ? 'Recording…'
            : 'Record test settlement'
        }
        cancelLabel="Keep test invoice due"
        tone="warning"
        onCancel={() => {
          if (!simulationBusyId) setSettleCharge(null);
        }}
        onConfirm={() => void settleSimulation()}
      />

      <ConfirmDialog
        open={checkoutInvoice !== null}
        title="Open secure payment checkout?"
        description={
          checkoutInvoice
            ? `Pay ${money(checkoutInvoice.totalAmount, checkoutInvoice.currency)} for invoice ${checkoutInvoice.invoiceNumber}. Returning from the provider does not by itself mark the invoice paid; iRexPro waits for a verified webhook.`
            : ''
        }
        confirmLabel={checkoutBusy ? 'Opening…' : 'Open checkout'}
        cancelLabel="Cancel"
        tone="primary"
        onCancel={() => {
          if (!checkoutBusy) setCheckoutInvoice(null);
        }}
        onConfirm={() => void beginCheckout()}
      />
    </DashboardShell>
  );
}
