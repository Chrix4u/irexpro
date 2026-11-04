import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('cTrader M1 near-miss SQL audit contract', () => {
  const script = readFileSync(
    resolve(__dirname, '../../../scripts/audit-m1-near-miss-cohort.sql'),
    'utf8',
  );

  it('cannot write to the database or send orders', () => {
    const sql = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(sql).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(sql).toContain("SET LOCAL statement_timeout = '30s';");
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|CALL)\b/i);
  });

  it('scopes candidates to connected DEMO cTrader and a mature decision window', () => {
    expect(script).toContain("b.broker_id = 'ctrader'");
    expect(script).toContain("b.account_type = 'DEMO'");
    expect(script).toContain('b.user_id = t.user_id');
    expect(script).toContain("t.execution_authority = 'NONE'");
    expect(script).toContain("t.route <> 'ABSTAIN'");
    expect(script).toContain("t.evaluated_at < now() - interval '25 minutes'");
    expect(script).toContain("(t.governance ->> 'netExpectedR')::numeric >= 0.08");
  });

  it('rejects missing, duplicate and non-live-cTrader quote evidence', () => {
    expect(script).toContain("c.source = 'ctrader-broker-native'");
    expect(script).toContain('c.positive_quote_sample_count > 0');
    expect(script).toContain('c.last_quote_sample_at >= c.bucket_time');
    expect(script).toContain("c.last_quote_sample_at < c.bucket_time + interval '1 minute'");
    expect(script).toContain('count(DISTINCT bucket_time) AS distinct_bars_observed');
    expect((script.match(/OR distinct_bars_observed <> 15/g) ?? []).length).toBe(2);
    expect(script).toContain("first_bar_time <> evaluated_at + interval '1 minute'");
    expect(script).toContain("last_bar_time <> evaluated_at + interval '15 minutes'");
    expect(script).toContain("THEN 'DATA_GAP'");
    expect(script).toContain("THEN 'AMBIGUOUS_SAME_MINUTE'");
  });

  it('uses only past same-account currency fee evidence and fails closed without five samples', () => {
    expect(script).toContain('h.broker_connection_id = d.broker_connection_id');
    expect(script).toContain('h.instrument = d.instrument');
    expect(script).toContain('h.account_currency = d.account_currency');
    expect(script).toContain("h.status = 'CLOSED'");
    expect(script).toContain('h.closed_at < d.evaluated_at');
    expect(script).toContain("h.closed_at >= d.evaluated_at - interval '21 days'");
    expect(script).toContain('ORDER BY h.closed_at DESC LIMIT 40');
    expect(script).toContain('CASE WHEN prior_fee_samples >= 5');
    expect(script).toContain('ELSE NULL');
    expect(script).toContain('mean_with_causal_p90_fees');
    expect(script).toContain('episodes_with_causal_fee_evidence');
  });

  it('separates Plan-B admission cohorts and exposes cost sensitivity', () => {
    expect(script).toContain('GROUP BY GROUPING SETS ((route), (route, planb_admitted))');
    expect(script).toContain("'ALL'");
    expect(script).toContain("count(*) FILTER (WHERE planb_admitted = 'true')");
    expect(script).toContain('mean_with_extra_010r_cost');
    expect(script).toContain('mean_with_extra_020r_cost');
    expect(script).toContain('mean_predicted_planb_net_r');
  });
});
