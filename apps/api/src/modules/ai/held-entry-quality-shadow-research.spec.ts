import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
const target = path.resolve(
  __dirname,
  '../../../scripts/research/replay-held-entry-quality-shadow.cjs',
);
const code = fs.readFileSync(target, 'utf8');
const { heldEntryWouldReject, analyze } = createRequire(__filename)(target);
const gov = {
  rolloutPhase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
  professionalM1FallbackExecutionEnabled: false,
  multimodelTrainedExpert: { state: 'ABSTAIN' },
  expectancy: { evidenceSamples: 0 },
  blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'ENSEMBLE_NOT_PAPER_ADMITTED'],
};
const record = {
  route: 'ABSTAIN',
  governance: gov,
  instrument: 'USDJPY',
  gross: '30',
  fee: '-6',
  swap: '0',
  opened_at: '2026-11-23T10:00:00Z',
  decision_at: '2026-11-23T09:59:00Z',
  decision_updated: '2026-11-23T10:10:00Z',
  intent_created: '2026-11-23T09:59:00Z',
  intent_updated: '2026-11-23T09:59:30Z',
  candidate: { alignedM5: 0.3, alignedM30DirectionalEfficiency: 0.08 },
};
describe('held double abstain rule: research replay only', () => {
  it('matches exact OOD and paper-admission defect, not any missing data', () => {
    expect(heldEntryWouldReject(record)).toBe(true);
    expect(
      heldEntryWouldReject({
        ...record,
        governance: { ...gov, expectancy: { evidenceSamples: null } },
      }),
    ).toBe(false);
    expect(heldEntryWouldReject({ ...record, governance: { ...gov, expectancy: {} } })).toBe(false);
    expect(
      heldEntryWouldReject({
        ...record,
        governance: { ...gov, professionalM1FallbackExecutionEnabled: true },
      }),
    ).toBe(false);
    expect(heldEntryWouldReject({ ...record, governance: { ...gov, rolloutPhase: 'LIVE' } })).toBe(
      false,
    );
    expect(
      heldEntryWouldReject({
        ...record,
        governance: { ...gov, multimodelTrainedExpert: { state: 'CONFIRM' } },
      }),
    ).toBe(false);
  });
  it('never selects trades using future P&L', () => {
    expect(heldEntryWouldReject({ ...record, gross: '-1000' })).toBe(true);
    expect(heldEntryWouldReject({ ...record, gross: '1000' })).toBe(true);
  });
  it('counts the historical winners sacrificed and losses averted without enabling an admission rule', () => {
    const rows = [
      record,
      {
        ...record,
        instrument: 'USDCAD',
        gross: '-200',
        opened_at: '2026-11-23T11:00:00Z',
        candidate: { alignedM5: -0.9, alignedM30DirectionalEfficiency: -0.2 },
      },
      {
        ...record,
        instrument: 'AUDUSD',
        route: 'M1_TREND_CONTINUATION',
        gross: '50',
        opened_at: '2026-11-23T12:00:00Z',
      },
    ];
    const result = analyze(rows);
    expect(result.mode).toBe('RESEARCH_ONLY_NO_ORDER_AUTHORITY');
    expect(result.sample).toMatchObject({ trades: 3, wins: 2, losses: 1, net: -138 });
    expect(result.heldEntryMatch).toMatchObject({ trades: 2, wins: 1, losses: 1, net: -182 });
    expect(result.originalNonMatches).toMatchObject({ trades: 1, wins: 1, net: 44 });
    expect(result.researchOnlySignCheck.meetsBoth).toMatchObject({ trades: 1, wins: 1 });
  });
  it('does not perform broker order actions', () => {
    expect(code).toContain("await c.query('BEGIN READ ONLY')");
    expect(code).toContain("await c.query('ROLLBACK')");
    expect(code).not.toMatch(/adapter\.(modifyOrder|placeOrder|closeOrder|cancelOrder)\s*\(/);
  });
});
