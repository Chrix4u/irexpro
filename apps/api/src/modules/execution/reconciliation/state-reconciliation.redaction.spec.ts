import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { StateReconciliationService } from './state-reconciliation.service';
import { ReconciliationRunStatus } from './reconciliation.enums';

describe('StateReconciliationService — provider error redaction', () => {
  it('redacts secret-like provider error material before persistence and audit', async () => {
    const secret = 'ABCDEFGHIJKLMNOP12345678';
    const sanitized = 'provider rejected token [redacted]';

    const tradeRepo = {};
    const orderRepo = {};
    const accountRepo = {};
    const brokerService = {};
    const adapter = {
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true }),
      listOrders: jest.fn().mockRejectedValue(new Error(`provider rejected token ${secret}`)),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getAccountInfo: jest.fn().mockResolvedValue({}),
    };
    const adapterRegistry = { getAdapterForConnection: jest.fn().mockReturnValue(adapter) };
    const encryptionService = { decrypt: jest.fn() };
    const persistence = {
      createRun: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', status: ReconciliationRunStatus.RUNNING }),
      failRun: jest.fn().mockResolvedValue(undefined),
    };
    const resolution = {};
    const orderService = {};
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const eventBus = {};

    const service = new StateReconciliationService(
      tradeRepo as never,
      orderRepo as never,
      accountRepo as never,
      brokerService as never,
      adapterRegistry as never,
      encryptionService as never,
      persistence as never,
      resolution as never,
      orderService as never,
      auditService as never,
      eventBus as never,
    );

    const connection = {
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'paper-broker',
      accountId: 'paper-account-001',
      accountType: 'DEMO',
      status: 'CONNECTED',
      credentialStatus: 'VERIFIED',
      encryptedCredentials: null,
      credentialIv: null,
      credentialTag: null,
      encryptionKeyId: null,
    } as unknown as BrokerConnection;

    const outcome = await service.runForConnection(connection);

    expect(outcome.status).toBe(ReconciliationRunStatus.FAILED);
    expect(persistence.failRun).toHaveBeenCalledWith('run-1', sanitized);

    const failureAudit = auditService.log.mock.calls.find(
      ([entry]) => entry.action === AuditAction.RECONCILIATION_RUN_FAILED,
    );
    expect(failureAudit).toBeDefined();
    expect(failureAudit?.[0]).toEqual(
      expect.objectContaining({
        action: AuditAction.RECONCILIATION_RUN_FAILED,
        metadata: expect.objectContaining({ reason: sanitized }),
      }),
    );

    expect(JSON.stringify(persistence.failRun.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(secret);
  });
});
