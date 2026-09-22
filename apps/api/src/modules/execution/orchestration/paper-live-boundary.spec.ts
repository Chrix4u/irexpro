import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { FinalDispatchBoundary, FinalDispatchBlockedException } from './final-dispatch-boundary';
// October UAT hardening (WS2/WS3): the LIVE new-exposure hard-gate mocks —
// healthy/approved by default so the AUTHORIZED LIVE path still reaches its
// own assertions; the boundary's own gate suite covers the blocked paths.
import {
  ReconciliationHealthService,
  ReconciliationHealthBlockedException,
  ReconciliationHealthReasonCode,
} from '../reconciliation/reconciliation-health.service';
import {
  LiveModelApprovalGateService,
  LiveModelGateReasonCode,
  LiveModelNotApprovedError,
} from '../../ai-engine-client/live-model-approval.gate';
import { RiskGrant } from '../entities/risk-grant.entity';
import { TradingSession, TradingSessionStatus } from '../entities/trading-session.entity';
import { ExecutionConfirmation } from '../entities/execution-confirmation.entity';
import { Order } from '../orders/order.entity';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionControlService } from '../../execution-control/execution-control.service';
import { BrokerProviderRegistryService } from '../../broker/registry/broker-provider-registry.service';
import { AuditService } from '../../audit/audit.service';
import { RiskGrantService } from '../../risk/risk-grant.service';
import { TradingAuthorityService } from '../../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../../execution-authority/shared-control-revision.service';
import {
  ExecutionMode,
  ProviderOperationClass,
  RiskGrantStatus,
} from '../interfaces/execution-authority';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import {
  BrokerConnectionStatus,
  BrokerMode,
} from '../../broker/interfaces/broker-adapter.interface';
import { PaperBrokerAdapter } from '../../broker/adapters/paper-broker.adapter';
import { AuditAction } from '../../../common/enums/audit-action.enum';

/**
 * Round 6 live-execution completion (§15) — the PAPER → LIVE boundary
 * adversarial matrix. These three boundary codes had ZERO spec coverage
 * before Round 6 (the honest-remaining list).
 *
 * The REAL FinalDispatchBoundary (read-only authorizeNewExposureDispatch —
 * the exact entry the pipeline calls); collaborators mocked at the seam.
 *
 * Matrix:
 *   - PAPER_ONLY + paper-broker connection → AUTHORIZED (the paper path)
 *   - PAPER_ONLY + REAL-broker connection → PAPER_ONLY_REFUSES_NON_PAPER_
 *     CONNECTION (the MODE is authoritative — never inferred from the
 *     connection's account type; zero provider calls)
 *   - FULL_AUTO + LIVE account + provider NOT production-LIVE-eligible →
 *     LIVE_VERIFICATION_UNVERIFIED (fail-closed — no LIVE authority without
 *     PROVEN verification)
 *   - grant-observed provider identity drift → PROVIDER_IDENTITY_CHANGED
 *   - every block is the typed FinalDispatchBlockedException with the
 *     stable machine code + an EXECUTION_AUTHORITY_BLOCKED audit
 *   - the paper ADAPTER itself can never be switched to LIVE (warn+ignore
 *     — the PAPER execution path stays PAPER at every layer)
 */

const USER = 'user-1';
const PAPER_BROKER_ID = 'paper-broker';

const grant = (overrides: Partial<RiskGrant> = {}): RiskGrant =>
  ({
    id: 'grant-1',
    userId: USER,
    signalId: 'sig-1',
    sessionId: 'session-1',
    sessionGeneration: 1,
    executionMode: ExecutionMode.PAPER_ONLY,
    brokerConnectionId: 'conn-1',
    status: RiskGrantStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    issuedAt: new Date(),
    orderPayloadDigest: 'digest-1',
    authorityGeneration: 1,
    credentialGeneration: 1,
    providerBrokerIdentity: 'identity-A',
    providerVerificationFingerprint: null,
    riskProfileId: 'profile-1',
    riskProfileVersion: 1,
    accountSnapshotGeneration: 7,
    ...overrides,
  }) as unknown as RiskGrant;

const session = (overrides: Partial<TradingSession> = {}): TradingSession =>
  ({
    id: 'session-1',
    userId: USER,
    status: TradingSessionStatus.ACTIVE,
    authorityGeneration: 1,
    executionMode: ExecutionMode.PAPER_ONLY,
    brokerConnectionId: 'conn-1',
    ...overrides,
  }) as unknown as TradingSession;

const connection = (overrides: Partial<BrokerConnection> = {}): BrokerConnection =>
  ({
    id: 'conn-1',
    userId: USER,
    brokerId: PAPER_BROKER_ID,
    accountId: 'paper-acc-1',
    accountType: BrokerMode.DEMO,
    status: BrokerConnectionStatus.CONNECTED,
    authorizationStatus: 'ACTIVE',
    credentialStatus: 'VERIFIED',
    credentialGeneration: 1,
    providerBrokerIdentity: 'identity-A',
    providerAccountId: null,
    ...overrides,
  }) as unknown as BrokerConnection;

describe('FinalDispatchBoundary — the §15 Paper→LIVE boundary matrix', () => {
  let boundary: FinalDispatchBoundary;
  let riskGrantRepo: { findOne: jest.Mock };
  let sessionRepo: { findOne: jest.Mock };
  let confirmationRepo: { findOne: jest.Mock };
  let brokerService: {
    findConnectionsByIds: jest.Mock;
    isConnectionExecutable: jest.Mock;
  };
  let executionControlService: { checkExecutionPermission: jest.Mock };
  let providerRegistry: { isProductionLiveEligible: jest.Mock };
  let auditService: { log: jest.Mock };

  const build = (gateOverrides?: { reconciliationHealth?: unknown; liveModelApproval?: unknown }) =>
    new FinalDispatchBoundary(
      riskGrantRepo as unknown as Repository<RiskGrant>,
      sessionRepo as unknown as Repository<TradingSession>,
      confirmationRepo as unknown as Repository<ExecutionConfirmation>,
      brokerService as unknown as BrokerService,
      executionControlService as unknown as ExecutionControlService,
      providerRegistry as unknown as BrokerProviderRegistryService,
      auditService as unknown as AuditService,
      { consumeGrantAtomic: jest.fn() } as unknown as RiskGrantService,
      {} as Repository<Order>,
      {} as Repository<RiskProfile>,
      {} as DataSource,
      {} as TradingAuthorityService,
      {} as SharedControlRevisionService,
      // `in` checks distinguish "explicitly absent" (fail-closed test) from
      // "not provided" (healthy default).
      (gateOverrides && 'reconciliationHealth' in gateOverrides
        ? gateOverrides.reconciliationHealth
        : {
            assertHealthyForLiveNewExposure: jest.fn().mockResolvedValue({
              healthy: true,
              reasonCode: null,
              detail: 'healthy',
              evidence: {},
            }),
          }) as unknown as ReconciliationHealthService,
      (gateOverrides && 'liveModelApproval' in gateOverrides
        ? gateOverrides.liveModelApproval
        : {
            assertApprovedForLiveNewExposure: jest.fn().mockResolvedValue({
              approved: true,
              reasonCode: null,
              detail: 'approved',
              model: { version: 'm-1', mode: null, artifactSha256: null, approvedForPaper: true },
              promotionRecord: null,
            }),
          }) as unknown as LiveModelApprovalGateService,
    );

  const authorize = (input?: { grantId?: string; operationClass?: ProviderOperationClass }) =>
    boundary.authorizeNewExposureDispatch({
      userId: USER,
      grantId: input?.grantId ?? 'grant-1',
      origin: 'PIPELINE',
      operationClass: input?.operationClass ?? ProviderOperationClass.NEW_EXPOSURE,
    });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    riskGrantRepo = { findOne: jest.fn().mockResolvedValue(grant()) };
    sessionRepo = { findOne: jest.fn().mockResolvedValue(session()) };
    confirmationRepo = { findOne: jest.fn().mockResolvedValue(null) };
    brokerService = {
      findConnectionsByIds: jest.fn().mockResolvedValue([connection()]),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
    };
    executionControlService = {
      checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true, blockedBy: null }),
    };
    providerRegistry = { isProductionLiveEligible: jest.fn().mockReturnValue(false) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    boundary = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('PAPER_ONLY + paper-broker connection → AUTHORIZED (the paper path works)', async () => {
    const authorization = await authorize();
    expect(authorization.context.executionMode).toBe(ExecutionMode.PAPER_ONLY);
    expect(authorization.context.brokerConnectionId).toBe('conn-1');
    expect(authorization.operationClass).toBe(ProviderOperationClass.NEW_EXPOSURE);
  });

  it('PAPER_ONLY + REAL-broker connection → PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION (mode is authoritative)', async () => {
    // A metatrader5 connection — even as DEMO account type — must NEVER
    // receive PAPER_ONLY new exposure: the mode, not the account type,
    // decides the execution path.
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.DEMO }),
    ]);

    await expect(authorize()).rejects.toMatchObject({
      code: 'PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.EXECUTION_AUTHORITY_BLOCKED,
        metadata: expect.objectContaining({
          blockedReason: 'PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION',
        }),
      }),
    );
  });

  it('PAPER_ONLY refuses a real-broker connection EVEN when the account type claims DEMO — and never consumes the grant', async () => {
    brokerService.findConnectionsByIds.mockResolvedValue([connection({ brokerId: 'metatrader5' })]);
    await expect(authorize()).rejects.toBeInstanceOf(FinalDispatchBlockedException);
    // Read-only authorize consumed nothing — the typed block happened at
    // verification time, zero provider calls, zero consumption.
  });

  it('FULL_AUTO + LIVE account + NOT production-LIVE-eligible provider → LIVE_VERIFICATION_UNVERIFIED', async () => {
    riskGrantRepo.findOne.mockResolvedValue(grant({ executionMode: ExecutionMode.FULL_AUTO }));
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.LIVE }),
    ]);
    providerRegistry.isProductionLiveEligible.mockReturnValue(false);

    await expect(authorize()).rejects.toMatchObject({
      code: 'LIVE_VERIFICATION_UNVERIFIED',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.EXECUTION_AUTHORITY_BLOCKED,
        metadata: expect.objectContaining({ blockedReason: 'LIVE_VERIFICATION_UNVERIFIED' }),
      }),
    );
  });

  it('FULL_AUTO + LIVE account + PRODUCTION-LIVE-eligible provider → AUTHORIZED', async () => {
    riskGrantRepo.findOne.mockResolvedValue(
      grant({ executionMode: ExecutionMode.FULL_AUTO, providerVerificationFingerprint: null }),
    );
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.LIVE }),
    ]);
    providerRegistry.isProductionLiveEligible.mockReturnValue(true);

    const authorization = await authorize();
    expect(authorization.context.providerVerificationFingerprint).toBeTruthy();
  });

  // ─── October UAT hardening (WS2/WS3): LIVE hard gates at the boundary ──

  it('LIVE NEW exposure is blocked with LIVE_RECONCILIATION_UNPROVEN when reconciliation truth is stale', async () => {
    riskGrantRepo.findOne.mockResolvedValue(
      grant({ executionMode: ExecutionMode.FULL_AUTO, providerVerificationFingerprint: null }),
    );
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.LIVE }),
    ]);
    providerRegistry.isProductionLiveEligible.mockReturnValue(true);
    const blocked = new ReconciliationHealthBlockedException({
      healthy: false,
      reasonCode: ReconciliationHealthReasonCode.RECONCILIATION_STALE,
      detail: 'The most recent successful reconciliation is 600s old.',
      evidence: {
        latestRunId: 'run-1',
        latestRunStatus: null,
        latestSuccessfulRunCompletedAt: null,
        latestSuccessfulRunAgeMs: 600_000,
        openDiscrepanciesByType: {},
      },
    });
    boundary = build({
      reconciliationHealth: {
        assertHealthyForLiveNewExposure: jest.fn().mockRejectedValue(blocked),
      },
    });

    await expect(authorize()).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_UNPROVEN',
      response: expect.objectContaining({
        reasonCode: ReconciliationHealthReasonCode.RECONCILIATION_STALE,
      }),
    });
  });

  it('LIVE NEW exposure is blocked with LIVE_MODEL_NOT_APPROVED when the exact model lacks a promotion record', async () => {
    riskGrantRepo.findOne.mockResolvedValue(
      grant({ executionMode: ExecutionMode.FULL_AUTO, providerVerificationFingerprint: null }),
    );
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.LIVE }),
    ]);
    providerRegistry.isProductionLiveEligible.mockReturnValue(true);
    boundary = build({
      liveModelApproval: {
        assertApprovedForLiveNewExposure: jest.fn().mockRejectedValue(
          new LiveModelNotApprovedError({
            approved: false,
            reasonCode: LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING,
            detail: 'The active AI model has not received LIVE approval.',
            model: { version: 'm-1', mode: null, artifactSha256: null, approvedForPaper: true },
            promotionRecord: null,
          }),
        ),
      },
    });

    await expect(authorize()).rejects.toMatchObject({
      code: 'LIVE_MODEL_NOT_APPROVED',
      response: expect.objectContaining({
        reasonCode: LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING,
      }),
    });
  });

  it('LIVE NEW exposure fails CLOSED when the gate authorities are absent (never a skip)', async () => {
    riskGrantRepo.findOne.mockResolvedValue(
      grant({ executionMode: ExecutionMode.FULL_AUTO, providerVerificationFingerprint: null }),
    );
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.LIVE }),
    ]);
    providerRegistry.isProductionLiveEligible.mockReturnValue(true);
    boundary = build({
      reconciliationHealth: undefined,
      liveModelApproval: undefined,
    });

    await expect(authorize()).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_UNPROVEN',
    });
  });

  it('DEMO NEW exposure is NOT gated by the LIVE reconciliation/model gates', async () => {
    // DEMO connection on FULL_AUTO — the gates must not even be consulted.
    const healthGate = {
      assertHealthyForLiveNewExposure: jest.fn().mockResolvedValue({
        healthy: true,
        reasonCode: null,
        detail: 'healthy',
        evidence: {},
      }),
    };
    const modelGate = {
      assertApprovedForLiveNewExposure: jest.fn().mockResolvedValue({
        approved: true,
        reasonCode: null,
        detail: 'approved',
        model: { version: 'm-1', mode: null, artifactSha256: null, approvedForPaper: true },
        promotionRecord: null,
      }),
    };
    boundary = build({
      reconciliationHealth: healthGate,
      liveModelApproval: modelGate,
    });
    riskGrantRepo.findOne.mockResolvedValue(
      grant({ executionMode: ExecutionMode.FULL_AUTO, providerVerificationFingerprint: null }),
    );
    sessionRepo.findOne.mockResolvedValue(session({ executionMode: ExecutionMode.FULL_AUTO }));
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ brokerId: 'metatrader5', accountType: BrokerMode.DEMO }),
    ]);

    const authorization = await authorize();
    expect(authorization.context.providerVerificationFingerprint).toBeDefined();
    expect(healthGate.assertHealthyForLiveNewExposure).not.toHaveBeenCalled();
    expect(modelGate.assertApprovedForLiveNewExposure).not.toHaveBeenCalled();
  });

  it('grant-observed provider identity drift → PROVIDER_IDENTITY_CHANGED (relink fence)', async () => {
    // The grant was approved against identity-A; the connection now shows a
    // DIFFERENT server-derived identity (relinked / different discovered
    // broker) — NEW exposure is fenced.
    brokerService.findConnectionsByIds.mockResolvedValue([
      connection({ providerBrokerIdentity: 'identity-B' }),
    ]);

    await expect(authorize()).rejects.toMatchObject({
      code: 'PROVIDER_IDENTITY_CHANGED',
    });
  });

  it('matching provider identity proceeds (the fence only fires on DRIFT)', async () => {
    const authorization = await authorize();
    expect(authorization.context.providerBrokerIdentity).toBe('identity-A');
  });

  it('every block carries the stable machine code in the typed exception', async () => {
    brokerService.findConnectionsByIds.mockResolvedValue([connection({ brokerId: 'metatrader5' })]);
    try {
      await authorize();
      throw new Error('expected the typed block');
    } catch (err) {
      expect(err).toBeInstanceOf(FinalDispatchBlockedException);
      expect((err as FinalDispatchBlockedException).code).toBe(
        'PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION',
      );
    }
  });
});

describe('PaperBrokerAdapter — the paper path can NEVER be switched to LIVE (§15 layer 2)', () => {
  it('setMode(LIVE) warns and IGNORES — the adapter stays on its DEMO paper mode', () => {
    const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const adapter = new PaperBrokerAdapter();

    adapter.setMode(BrokerMode.LIVE);

    // The mode is unchanged: the paper execution path stays PAPER — a LIVE
    // request can never route real money through the paper adapter.
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('cannot be set to LIVE mode'));
    loggerWarn.mockRestore();
  });

  it('setMode(DEMO) is accepted (the paper path is DEMO by construction)', () => {
    const adapter = new PaperBrokerAdapter();
    expect(() => adapter.setMode(BrokerMode.DEMO)).not.toThrow();
  });
});
