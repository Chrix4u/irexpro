import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflowPath = resolve(
  __dirname,
  '../../../../../.github/workflows/vps-no-trade-diagnostics.yml',
);

function workflowSource(): string {
  return readFileSync(workflowPath, 'utf8');
}

describe('VPS no-trade diagnostics workflow contract', () => {
  it('runs after the protected staging deployment instead of racing the main push', () => {
    const source = workflowSource();

    expect(source).toContain('workflow_run:');
    expect(source).toContain("workflows: ['Staging Deploy']");
    expect(source).toContain('types: [completed]');
    expect(source).not.toContain('push:\n    branches: [main]');
    expect(source).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(source).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it('binds diagnostics to the exact deployed SHA and exposes failed dispatches', () => {
    const source = workflowSource();

    expect(source).toContain('EXPECTED_DEPLOY_SHA:');
    expect(source).toContain('github.event.workflow_run.head_sha');
    expect(source).toContain('actual_staging_sha');
    expect(source).toContain('VPS staging SHA mismatch');
    expect(source).toContain("('latest_execution_failed', 'outcome=EXECUTION_FAILED')");
    expect(source).toContain("('latest_risk_rejected', 'outcome=RISK_REJECTED')");
  });
  it('identifies per-pair cTrader broker-native M1 evidence without printing credentials or accounts', () => {
    const source = workflowSource();

    expect(source).toContain('ctrader_m1_persisted_freshness');
    expect(source).toContain('ctrader_active_demo_sources');
    expect(source).toContain('owner_demo_broker_connection_counts');
    expect(source).toContain('ctrader_collector_m1_error_class_counts');
    expect(source).toContain("c.source = 'ctrader-broker-native'");
    expect(source).toContain("s.execution_mode = 'FULL_AUTO'");
    expect(source).toContain("s.status::text = 'ACTIVE'");
    expect(source).toContain("b.account_type = 'DEMO'");
    expect(source).toContain(
      "allowed_pairs = {'AUDUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY'}",
    );
    // Only whitelisted categories leave the VPS, never raw provider log errors.
    expect(source).toContain('collector_errors[(pair, reason)] += 1');
    expect(source).not.toContain("print(f'collector_raw");
  });
});
