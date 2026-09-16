import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BrokerController } from './broker.controller';
import { BrokerService } from './broker.service';
import { BrokerDemoValidationService } from './services/broker-demo-validation.service';
import { DEMO_VALIDATION_STEPS } from './verification/provider-verification-harness';

/**
 * BrokerController — DEMO validation route wiring (Sprint 56 / Task 47-C5;
 * re-integrated onto new main as Task 48-D).
 *
 * Follows the broker.controller.identity.spec.ts style: the controller methods
 * are invoked directly, simulating what the @CurrentUserId() decorator would
 * inject. Pins:
 * - POST :connectionId/validate-demo delegates to BrokerDemoValidationService
 *   with ONLY the UUID string + userId (ownership enforced in the service);
 * - the 200 response shape: sanitized checklist result + demoValidated boolean;
 * - typed error propagation (BadRequest for LIVE, NotFound for foreign ids)
 *   so the route keeps its documented 400/404 contract.
 */
describe('BrokerController (validate-demo route wiring)', () => {
  let controller: BrokerController;
  let brokerService: Record<string, jest.Mock>;
  let demoValidationService: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const OTHER_USER_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  const CONNECTION_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

  const validationResult = {
    connectionId: CONNECTION_ID,
    brokerId: 'paper-broker',
    accountType: 'DEMO' as const,
    demoValidated: true,
    overall: 'PASS' as const,
    summary: { passed: DEMO_VALIDATION_STEPS.length, failed: 0, skipped: 0 },
    steps: [
      {
        name: 'connect',
        status: 'PASS' as const,
        detail: 'DEMO connection reached CONNECTED state',
      },
      { name: 'market-order', status: 'PASS' as const, providerOrderId: 'paper-order-000001' },
    ],
    startedAt: '2024-01-02T03:04:05.000Z',
    finishedAt: '2024-01-02T03:04:06.000Z',
  };

  beforeEach(() => {
    brokerService = {
      getSupportedBrokers: jest.fn().mockResolvedValue([]),
      findConnectionsByUser: jest.fn().mockResolvedValue([]),
      findConnectionById: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
      testCredentials: jest.fn().mockResolvedValue({ success: true }),
      createConnection: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
      connectBroker: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
      disconnectBroker: jest.fn().mockResolvedValue(undefined),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
      enableLiveTrading: jest.fn().mockResolvedValue(undefined),
    };
    demoValidationService = {
      validateDemoConnection: jest.fn().mockResolvedValue(validationResult),
    };

    controller = new BrokerController(
      brokerService as unknown as BrokerService,
      demoValidationService as unknown as BrokerDemoValidationService,
    );
  });

  it('delegates to BrokerDemoValidationService with only the UUID string + userId', async () => {
    const result = await controller.validateDemoConnection(CONNECTION_ID, USER_ID);
    expect(demoValidationService.validateDemoConnection).toHaveBeenCalledTimes(1);
    expect(demoValidationService.validateDemoConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      USER_ID,
    );
    const [connectionIdArg, userIdArg] = demoValidationService.validateDemoConnection.mock
      .calls[0] as unknown[];
    expect(typeof connectionIdArg).toBe('string');
    expect(typeof userIdArg).toBe('string');
    // The validation never routes through BrokerService directly.
    expect(brokerService.connectBroker).not.toHaveBeenCalled();
    expect(result).toEqual(validationResult);
  });

  it('returns the 200 shape: sanitized checklist steps + demoValidated boolean', async () => {
    const result = await controller.validateDemoConnection(CONNECTION_ID, USER_ID);
    expect(result).toMatchObject({
      connectionId: CONNECTION_ID,
      brokerId: 'paper-broker',
      accountType: 'DEMO',
      demoValidated: true,
      overall: 'PASS',
    });
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps[0]).toMatchObject({ name: 'connect', status: 'PASS' });
    expect(result.summary).toEqual({ passed: DEMO_VALIDATION_STEPS.length, failed: 0, skipped: 0 });
    // Provider order ids are the only identifiers carried — no credentials ever.
    expect(JSON.stringify(result)).not.toContain('encryptedCredentials');
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });

  it('passes the requesting userId through for ownership (not another user)', async () => {
    await controller.validateDemoConnection(CONNECTION_ID, OTHER_USER_ID);
    expect(demoValidationService.validateDemoConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      OTHER_USER_ID,
    );
  });

  it('propagates NotFound for a connection the service cannot find (foreign owner)', async () => {
    demoValidationService.validateDemoConnection.mockRejectedValueOnce(
      new NotFoundException('Broker connection not found'),
    );
    await expect(controller.validateDemoConnection(CONNECTION_ID, OTHER_USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('propagates BadRequest for LIVE connections (404/400 contract stays honest)', async () => {
    demoValidationService.validateDemoConnection.mockRejectedValueOnce(
      new BadRequestException('Only DEMO connections can be validated.'),
    );
    await expect(controller.validateDemoConnection(CONNECTION_ID, USER_ID)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns the honest FAIL shape unchanged (no error mapping for step failures)', async () => {
    const failing = {
      ...validationResult,
      overall: 'FAIL' as const,
      demoValidated: false,
      summary: { passed: 3, failed: 1, skipped: 10 },
      steps: [
        { name: 'connect', status: 'PASS' as const },
        { name: 'account-info', status: 'FAIL' as const, detail: 'BROKER_SERVER_ERROR: boom' },
      ],
    };
    demoValidationService.validateDemoConnection.mockResolvedValueOnce(failing);
    const result = await controller.validateDemoConnection(CONNECTION_ID, USER_ID);
    expect(result.overall).toBe('FAIL');
    expect(result.demoValidated).toBe(false);
    expect(result.steps.find((s) => s.name === 'account-info')?.status).toBe('FAIL');
  });
});
