'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaymentProviderInfo } from '@irexpro/types';
import { Alert, Badge, Button, Card, EmptyState, Input } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';

type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID' | 'OVERDUE' | 'CANCELLED';
type PaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'NONE';

interface PerformanceFeeInvoiceView {
  invoiceId: string;
  userId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: string;
  dueDate: string | null;
  paidAt: string | null;
  assessmentId: string | null;
  assessmentStatus: string | null;
  paymentStatus: PaymentStatus;
  provider: string | null;
  checkoutSessionId: string | null;
  manual: boolean;
  createdAt: string;
}

type Filter = 'ALL' | 'ISSUED' | 'OVERDUE' | 'PAID' | 'PROCESSING' | 'FAILED';

function currencyMinorDigits(currency: string): number {
  const upper = currency.toUpperCase();
  if (['JPY', 'KRW'].includes(upper)) return 0;
  if (['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(upper)) return 3;
  return 2;
}

function formatMinor(amount: string, currency: string): string {
  try {
    const value = BigInt(amount);
    const digits = currencyMinorDigits(currency);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    if (digits === 0) return `${negative ? '-' : ''}${absolute.toString()} ${currency}`;
    const base = 10n ** BigInt(digits);
    const major = absolute / base;
    const minor = (absolute % base).toString().padStart(digits, '0');
    return `${negative ? '-' : ''}${major.toString()}.${minor} ${currency}`;
  } catch {
    return `— ${currency}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function invoiceBadge(status: InvoiceStatus): 'success' | 'error' | 'warning' | 'info' {
  if (status === 'PAID') return 'success';
  if (status === 'OVERDUE') return 'error';
  if (status === 'ISSUED') return 'warning';
  return 'info';
}

function paymentBadge(status: PaymentStatus): 'success' | 'error' | 'warning' | 'info' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED') return 'error';
  if (status === 'PROCESSING' || status === 'PENDING') return 'warning';
  return 'info';
}

export default function AdminPaymentsPage() {
  const { hasAdminRole } = useAuth();
  const [invoices, setInvoices] = useState<PerformanceFeeInvoiceView[]>([]);
  const [providers, setProviders] = useState<PaymentProviderInfo[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (!hasAdminRole) return;
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const [nextInvoices, nextProviders] = await Promise.all([
        api.request<PerformanceFeeInvoiceView[]>('/performance-fees/invoices?limit=200'),
        api.listProviders(),
      ]);
      setInvoices(nextInvoices);
      setProviders(nextProviders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load payment operations.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [hasAdminRole]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const filterMatch =
        filter === 'ALL' ||
        invoice.status === filter ||
        invoice.paymentStatus === filter;
      if (!filterMatch) return false;
      if (!needle) return true;
      return [
        invoice.invoiceNumber,
        invoice.invoiceId,
        invoice.userId,
        invoice.provider ?? '',
        invoice.status,
        invoice.paymentStatus,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [filter, invoices, query]);

  const liveProviders = providers.filter((provider) => provider.isLive);
  const issued = invoices.filter((invoice) => invoice.status === 'ISSUED').length;
  const overdue = invoices.filter((invoice) => invoice.status === 'OVERDUE').length;
  const processing = invoices.filter((invoice) => invoice.paymentStatus === 'PROCESSING').length;
  const paid = invoices.filter((invoice) => invoice.status === 'PAID').length;

  if (!hasAdminRole) {
    return (
      <>
        <h1>Access denied</h1>
        <Card title="Insufficient permissions">
          <Alert variant="error">Your account does not have admin access.</Alert>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Payments</h1>
          <p className="muted">
            Performance-fee invoices and provider state. Only verified provider
            webhooks may settle an invoice; this portal is read-only for payment truth.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={refreshing}
          onClick={() => void load(true)}
        >
          Refresh
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
        <div className="stat-card">
          <div className="stat-card__label">Invoices</div>
          <div className="stat-card__value">{invoices.length}</div>
          <div className="stat-card__hint">Performance-fee records</div>
        </div>
        <div className="stat-card stat-card--warning">
          <div className="stat-card__label">Issued</div>
          <div className="stat-card__value">{issued}</div>
          <div className="stat-card__hint">Awaiting settlement</div>
        </div>
        <div className="stat-card stat-card--error">
          <div className="stat-card__label">Overdue</div>
          <div className="stat-card__value">{overdue}</div>
          <div className="stat-card__hint">Needs attention</div>
        </div>
        <div className="stat-card stat-card--warning">
          <div className="stat-card__label">Processing</div>
          <div className="stat-card__value">{processing}</div>
          <div className="stat-card__hint">Provider session active</div>
        </div>
        <div className="stat-card stat-card--success">
          <div className="stat-card__label">Paid</div>
          <div className="stat-card__value">{paid}</div>
          <div className="stat-card__hint">Webhook verified</div>
        </div>
      </div>

      <Card title="Payment provider readiness">
        <p className="muted" style={{ marginBottom: '1rem' }}>
          A configured secret is not enough: only providers marked live are available
          for real customer checkout.
        </p>
        {providers.length === 0 ? (
          <EmptyState
            icon="💳"
            title="No providers registered"
            description="The payment provider registry returned no public providers."
          />
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table" aria-label="Payment provider readiness">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Mode</th>
                  <th>Currencies</th>
                  <th>Countries</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => (
                  <tr key={provider.id}>
                    <td className="admin-table__cell-strong">{provider.displayName}</td>
                    <td>
                      <Badge variant={provider.isLive ? 'success' : provider.isSandbox ? 'warning' : 'info'}>
                        {provider.isLive ? 'LIVE' : provider.isSandbox ? 'SANDBOX' : 'DISABLED'}
                      </Badge>
                    </td>
                    <td>{provider.supportedCurrencies.join(', ') || '—'}</td>
                    <td>{provider.supportedCountries.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {liveProviders.length === 0 ? (
          <Alert variant="warning">
            No production payment provider is live. Customer fee checkout remains unavailable,
            although invoices and fee calculations can still be reviewed.
          </Alert>
        ) : null}
      </Card>

      <Card title="Performance-fee invoices">
        <div className="admin-audit-filter-form" style={{ marginBottom: '1rem' }}>
          <div className="admin-audit-filter-form__fields">
            <Input
              label="Search"
              placeholder="Invoice, user ID, provider…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <div className="filter-group" aria-label="Payment filters">
          {(['ALL', 'ISSUED', 'OVERDUE', 'PROCESSING', 'FAILED', 'PAID'] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              className="filter-group__btn"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="muted">Loading payment records…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="🧾"
            title="No matching invoices"
            description="No performance-fee invoices match the current filter."
          />
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table" aria-label="Performance fee invoices">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>User</th>
                  <th>Amount</th>
                  <th>Invoice status</th>
                  <th>Payment status</th>
                  <th>Provider</th>
                  <th>Due</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((invoice) => (
                  <tr key={invoice.invoiceId}>
                    <td>
                      <div className="admin-table__cell-strong">{invoice.invoiceNumber}</div>
                      <div className="admin-table__cell-muted">{formatDate(invoice.createdAt)}</div>
                    </td>
                    <td className="admin-table__cell-mono">{invoice.userId}</td>
                    <td className="admin-table__cell-strong">
                      {formatMinor(invoice.totalAmount, invoice.currency)}
                    </td>
                    <td>
                      <Badge variant={invoiceBadge(invoice.status)}>{invoice.status}</Badge>
                    </td>
                    <td>
                      <Badge variant={paymentBadge(invoice.paymentStatus)}>
                        {invoice.paymentStatus}
                      </Badge>
                    </td>
                    <td>{invoice.provider ?? '—'}</td>
                    <td>{formatDate(invoice.dueDate)}</td>
                    <td>{formatDate(invoice.paidAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="admin-table-footer">
          <span className="admin-table-footer__count">
            Showing {visible.length} of {invoices.length} invoice{invoices.length === 1 ? '' : 's'}
          </span>
        </div>
      </Card>
    </>
  );
}
