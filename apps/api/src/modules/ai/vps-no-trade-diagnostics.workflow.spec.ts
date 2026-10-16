import fs from 'node:fs';
import path from 'node:path';

const workflowPath = path.resolve(
  __dirname,
  '../../../../../.github/workflows/vps-no-trade-diagnostics.yml',
);

function workflowSource(): string {
  return fs.readFileSync(workflowPath, 'utf8');
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
});
