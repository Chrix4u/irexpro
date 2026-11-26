'use client';

import { useRef, useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import {
  verifyStatementConsistency,
  type StatementConsistencyReport,
} from '@irexpro/types/statement-consistency';

const CHECK_LABELS: Record<keyof StatementConsistencyReport['checks'], string> = {
  consecutiveDealBalancesAgree: 'Consecutive deal balances',
  lastDealBalanceAgrees: 'Final deal balance',
  realisedSummaryAgrees: 'Realised profit and loss',
  equityIdentityAgrees: 'Equity calculation',
  freeMarginIdentityAgrees: 'Free margin calculation',
  fundingSummaryAgrees: 'Deposit and withdrawal totals',
};

export function StatementConsistencyPanel() {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [report, setReport] = useState<StatementConsistencyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function inspect(file: File | undefined) {
    const request = ++generation.current;
    setReport(null);
    setError(false);
    setLoading(false);
    if (!file) return;
    if (file.size > 2_000_000 || !file.name.toLowerCase().endsWith('.csv')) {
      setError(true);
      return;
    }
    setLoading(true);
    try {
      const text = await file.text();
      if (request !== generation.current) return;
      setReport(verifyStatementConsistency(text));
    } catch {
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  function clear() {
    generation.current++;
    if (input.current) input.current.value = '';
    setReport(null);
    setError(false);
    setLoading(false);
  }

  return (
    <Card title="Private broker statement validation">
      <p className="muted text-sm">
        Select a native cTrader USD Deals CSV (UTC+0, up to 2 MB). The file is inspected
        in your browser only. It is not uploaded, stored or used to change orders.
      </p>
      <div className="filter-group">
        <label htmlFor="statement-csv">Broker statement CSV</label>
        <input
          id="statement-csv"
          ref={input}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            void inspect(event.target.files?.[0]);
          }}
        />
        <Button variant="secondary" size="sm" onClick={clear}>Clear</Button>
      </div>
      {loading && <p role="status">Checking statement…</p>}
      {error && (
        <Alert variant="error">
          Unsupported or invalid statement. Choose a complete native USD Deals CSV under 2 MB.
        </Alert>
      )}
      {report && (
        <div aria-live="polite">
          <p><strong>{report.status === 'ARITHMETIC_CONSISTENT' ? 'Arithmetic consistent' : 'Review required'}</strong></p>
          <p>{report.deals} deal records; {report.distinctEconomicKeys} distinct economic keys.</p>
          <div className="admin-table-scroll">
            <table className="admin-table" aria-label="Statement consistency checks">
              <thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead>
              <tbody>
                {(Object.keys(CHECK_LABELS) as Array<keyof typeof CHECK_LABELS>).map((key) => (
                  <tr key={key}>
                    <td>{CHECK_LABELS[key]}</td>
                    <td>{report.checks[key] ? 'Consistent' : 'Review required'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.consecutiveBalanceMismatchRows.length > 0 && (
            <p>Deal rows requiring balance review: {report.consecutiveBalanceMismatchRows.slice(0, 30).join(', ')}
              {report.consecutiveBalanceMismatchRows.length > 30 ? ' (first 30 shown)' : ''}
            </p>
          )}
          <p className="muted text-sm">
            Arithmetic validation is not authenticated broker reconciliation. Account identity,
            order settlement and current exposure remain unverified.
          </p>
        </div>
      )}
    </Card>
  );
}
