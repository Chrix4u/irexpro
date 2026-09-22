import { ReconciliationHealthBlockedException } from './reconciliation-health.service';
import {
  DEFAULT_RECONCILIATION_HEALTH_POLICY,
  ReconciliationHealthReasonCode,
  ReconciliationHealthService,
} from './reconciliation-health.service';
import { ReconciliationRun } from './entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from './entities/reconciliation-discrepancy.entity';
import { ReconciliationDiscrepancyType, ReconciliationRunStatus } from './reconciliation.enums';

/**
 * October UAT hardening (WS2) — the typed reconciliation-health decision the
 * LIVE new-exposure hard gates enforce (risk pipeline step 1f + the final
 * dispatch boundary 6b). PAPER/DEMO are never gated.
 */
describe('ReconciliationHealthService (WS2 LIVE hard gate)', () => {
  let service: ReconciliationHealthService;
  let runRepo: { findOne: jest.Mock };
  let discrepancyRepo: { find: jest.Mock };
  const now = new Date('2026-09-21T12:00:00.000Z');
  const CONNECTION = 'conn-1';

  const makeRun = (overrides: Partial<ReconciliationRun> = {}): ReconciliationRun =>
    ({
      id: 'run-1',
      brokerConnectionId: CONNECTION,
      status: ReconciliationRunStatus.COMPLETED,
      startedAt: new Date(now.getTime() - 60_000),
      completedAt: new Date(now.getTime() - 30_000),
      errorSummary: null,
      createdAt: new Date(now.getTime() - 60_000),
      ...overrides,
    }) as ReconciliationRun;

  const makeDiscrepancy = (type: ReconciliationDiscrepancyType): ReconciliationDiscrepancy =>
    ({ type }) as ReconciliationDiscrepancy;

  const healthyRun = () => {
    runRepo.findOne.mockImplementation((criteria: { order?: Record<string, string> }) =>
      // order: { createdAt: 'DESC' } → latest run; { completedAt: 'DESC' } → latest successful
      criteria?.order?.completedAt ? makeRun() : makeRun(),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    runRepo = { findOne: jest.fn() };
    discrepancyRepo = { find: jest.fn().mockResolvedValue([]) };
    service = new ReconciliationHealthService(
      runRepo as never,
      discrepancyRepo as never,
      DEFAULT_RECONCILIATION_HEALTH_POLICY,
    );
  });

  // ─── Healthy ──────────────────────────────────────────────────────────────

  it('a current COMPLETED run with zero OPEN discrepancies is healthy', async () => {
    healthyRun();
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(true);
    expect(decision.reasonCode).toBeNull();
  });

  it('a COMPLETED_WITH_WARNINGS run with no OPEN discrepancies is healthy (warnings were resolved)', async () => {
    runRepo.findOne.mockImplementation((criteria: { order?: Record<string, string> }) =>
      criteria?.order?.completedAt
        ? makeRun()
        : makeRun({ status: ReconciliationRunStatus.COMPLETED_WITH_WARNINGS }),
    );
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(true);
  });

  it('healthy allows progression to the LIVE gate (assert resolves)', async () => {
    healthyRun();
    const decision = await service.assertHealthyForLiveNewExposure(CONNECTION, now);
    expect(decision.healthy).toBe(true);
  });

  // ─── Failed / stale ───────────────────────────────────────────────────────

  it('a FAILED latest run blocks with RECONCILIATION_FAILED', async () => {
    runRepo.findOne.mockImplementation((criteria: { order?: Record<string, string> }) =>
      criteria?.order?.completedAt
        ? makeRun({ completedAt: new Date(now.getTime() - 10 * 60_000) })
        : makeRun({ status: ReconciliationRunStatus.FAILED, errorSummary: 'provider unreachable' }),
    );
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_FAILED);
    expect(decision.detail).toContain('provider unreachable');
  });

  it('no runs at all blocks with RECONCILIATION_STALE (truth cannot be established)', async () => {
    runRepo.findOne.mockResolvedValue(null);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_STALE);
    expect(decision.detail).toContain('No completed reconciliation run exists');
  });

  it('a successful run older than the policy window blocks with RECONCILIATION_STALE', async () => {
    const stale = new Date(
      now.getTime() - DEFAULT_RECONCILIATION_HEALTH_POLICY.maxSuccessfulRunAgeMs - 1_000,
    );
    runRepo.findOne.mockImplementation(() => makeRun({ completedAt: stale }));
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_STALE);
    expect(decision.evidence.latestSuccessfulRunAgeMs).toBeGreaterThan(
      DEFAULT_RECONCILIATION_HEALTH_POLICY.maxSuccessfulRunAgeMs,
    );
  });

  it('a run stalled in-flight beyond policy blocks with RECONCILIATION_STALE (dead sweeper)', async () => {
    const stuckSince = new Date(
      now.getTime() - DEFAULT_RECONCILIATION_HEALTH_POLICY.maxInFlightRunAgeMs - 60_000,
    );
    runRepo.findOne.mockImplementation((criteria: { order?: Record<string, string> }) =>
      criteria?.order?.completedAt
        ? makeRun({ completedAt: new Date(now.getTime() - 30_000) })
        : makeRun({
            status: ReconciliationRunStatus.RUNNING,
            startedAt: stuckSince,
            completedAt: null as unknown as Date,
          }),
    );
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_STALE);
  });

  // ─── Open divergence classes ──────────────────────────────────────────────

  it('an OPEN unknown-provider-position discrepancy blocks with UNRESOLVED_POSITION_DIVERGENCE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.UNRESOLVED_POSITION_DIVERGENCE);
  });

  it('an OPEN position-closed-externally discrepancy blocks with UNRESOLVED_POSITION_DIVERGENCE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.UNRESOLVED_POSITION_DIVERGENCE);
  });

  it('an OPEN stale-order-state discrepancy blocks with UNRESOLVED_ORDER_DIVERGENCE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.STALE_ORDER_STATE),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.UNRESOLVED_ORDER_DIVERGENCE);
  });

  it('an OPEN unresolved-execution-result discrepancy blocks with UNRESOLVED_ORDER_DIVERGENCE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.UNRESOLVED_ORDER_DIVERGENCE);
  });

  it('an OPEN protective-order divergence blocks with PROTECTIVE_ORDER_DIVERGENCE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.PROTECTIVE_ORDER_DIVERGENCE),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.PROTECTIVE_ORDER_DIVERGENCE);
    expect(decision.detail).toContain('protective orders');
  });

  it('an OPEN account-state mismatch blocks with ACCOUNT_STATE_UNAVAILABLE', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.ACCOUNT_STATE_UNAVAILABLE);
  });

  it('precedence: FAILED beats stale beats divergence classes', async () => {
    // FAILED latest + stale successful + every divergence open at once.
    runRepo.findOne.mockImplementation((criteria: { order?: Record<string, string> }) =>
      criteria?.order?.completedAt
        ? makeRun({ completedAt: new Date(now.getTime() - 60 * 60_000) })
        : makeRun({ status: ReconciliationRunStatus.FAILED }),
    );
    discrepancyRepo.find.mockResolvedValue(
      Object.values(ReconciliationDiscrepancyType).map(makeDiscrepancy),
    );
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_FAILED);
  });

  it('position divergence outranks order divergence when both are open', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.STALE_ORDER_STATE),
      makeDiscrepancy(ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.UNRESOLVED_POSITION_DIVERGENCE);
  });

  // ─── Policy + assertion ───────────────────────────────────────────────────

  it('the policy is explicit typed configuration (no magic values) and overridable', async () => {
    const tight = new ReconciliationHealthService(runRepo as never, discrepancyRepo as never, {
      maxSuccessfulRunAgeMs: 10_000,
      maxInFlightRunAgeMs: 20_000,
    });
    runRepo.findOne.mockImplementation(() =>
      makeRun({ completedAt: new Date(now.getTime() - 60_000) }),
    );
    const decision = await tight.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.healthy).toBe(false);
    expect(decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_STALE);
  });

  it('the LIVE assertion throws the typed blocked exception with the decision', async () => {
    runRepo.findOne.mockResolvedValue(null);
    await expect(service.assertHealthyForLiveNewExposure(CONNECTION, now)).rejects.toBeInstanceOf(
      ReconciliationHealthBlockedException,
    );
    try {
      await service.assertHealthyForLiveNewExposure(CONNECTION, now);
    } catch (err) {
      const blocked = err as ReconciliationHealthBlockedException;
      expect(blocked.decision.reasonCode).toBe(ReconciliationHealthReasonCode.RECONCILIATION_STALE);
      expect(blocked.decision.evidence.latestRunId).toBeNull();
    }
  });

  it('evidence carries the safe discrepancy-class counts for audits', async () => {
    healthyRun();
    discrepancyRepo.find.mockResolvedValue([
      makeDiscrepancy(ReconciliationDiscrepancyType.STALE_ORDER_STATE),
      makeDiscrepancy(ReconciliationDiscrepancyType.STALE_ORDER_STATE),
      makeDiscrepancy(ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION),
    ]);
    const decision = await service.evaluateReconciliationHealth(CONNECTION, now);
    expect(decision.evidence.openDiscrepanciesByType).toEqual({
      STALE_ORDER_STATE: 2,
      UNKNOWN_PROVIDER_POSITION: 1,
    });
  });
});
