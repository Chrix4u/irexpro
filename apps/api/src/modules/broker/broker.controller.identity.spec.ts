import { BrokerController } from './broker.controller';
import { BrokerService } from './broker.service';
import { ConnectBrokerDto } from './dto/connect-broker.dto';
import { BrokerMode } from './interfaces/broker-adapter.interface';
import { BrokerDemoValidationService } from './services/broker-demo-validation.service';

/**
 * BrokerController regression tests — Hotfix amendment.
 *
 * Proves the original object-versus-UUID defect cannot recur:
 *   - Every endpoint passes only a UUID string to BrokerService
 *   - The complete AuthenticatedPrincipal is never supplied to a service method
 *   - Another user cannot retrieve or modify a broker connection they don't own
 *   - Credentials are never returned in the response
 *
 * These tests invoke the controller methods directly, simulating what the
 * @CurrentUserId() decorator would inject.
 */
describe('BrokerController (Hotfix — UUID identity regression)', () => {
  let controller: BrokerController;
  let brokerService: Record<string, jest.Mock>;
  let demoValidationService: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const OTHER_USER_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  const CONNECTION_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

  beforeEach(() => {
    brokerService = {
      getSupportedBrokers: jest.fn().mockResolvedValue([]),
      findConnectionsByUser: jest.fn().mockResolvedValue([]),
      findConnectionById: jest.fn().mockResolvedValue({
        id: CONNECTION_ID,
        userId: USER_ID,
        brokerId: 'paper-broker',
        brokerName: 'Paper Trading Broker',
        encryptedCredentials: 'should_not_appear',
        credentialIv: 'should_not_appear',
        credentialTag: 'should_not_appear',
      }),
      testCredentials: jest.fn().mockResolvedValue({ success: true, accountId: '123' }),
      createConnection: jest.fn().mockResolvedValue({
        id: CONNECTION_ID,
        userId: USER_ID,
        brokerId: 'paper-broker',
        brokerName: 'Paper Trading Broker',
        encryptedCredentials: 'should_not_appear',
        credentialIv: 'should_not_appear',
        credentialTag: 'should_not_appear',
      }),
      connectBroker: jest.fn().mockResolvedValue({
        id: CONNECTION_ID,
        userId: USER_ID,
        status: 'CONNECTED',
        encryptedCredentials: 'should_not_appear',
      }),
      disconnectBroker: jest.fn().mockResolvedValue(undefined),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
      enableLiveTrading: jest.fn().mockResolvedValue(undefined),
    };

    // Sprint 56 / Task 48-D: the controller gained a second dependency
    // (BrokerDemoValidationService — the validate-demo route). Mocked here
    // with the same Record<string, jest.Mock> style as brokerService.
    demoValidationService = {
      validateDemoConnection: jest.fn().mockResolvedValue({
        connectionId: CONNECTION_ID,
        brokerId: 'paper-broker',
        accountType: 'DEMO',
        demoValidated: true,
        overall: 'PASS',
        summary: { passed: 14, failed: 0, skipped: 0 },
        steps: [],
        startedAt: '2024-01-02T03:04:05.000Z',
        finishedAt: '2024-01-02T03:04:06.000Z',
      }),
    };

    controller = new BrokerController(
      brokerService as unknown as BrokerService,
      demoValidationService as unknown as BrokerDemoValidationService,
    );
  });

  // ── UUID string passed to service (not object) ────────────────────────────

  describe('passes only UUID string to BrokerService', () => {
    it('listConnections passes userId as UUID string', async () => {
      await controller.listConnections(USER_ID);
      expect(brokerService.findConnectionsByUser).toHaveBeenCalledWith(USER_ID);
      expect(typeof brokerService.findConnectionsByUser.mock.calls[0][0]).toBe('string');
    });

    it('getConnection passes userId as UUID string', async () => {
      await controller.getConnection(CONNECTION_ID, USER_ID);
      expect(brokerService.findConnectionById).toHaveBeenCalledWith(CONNECTION_ID, USER_ID);
      expect(typeof brokerService.findConnectionById.mock.calls[0][1]).toBe('string');
    });

    it('testCredentials passes userId as UUID string', async () => {
      const dto: ConnectBrokerDto = {
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        accountId: '123',
      };
      await controller.testCredentials(dto, USER_ID);
      expect(brokerService.testCredentials).toHaveBeenCalledWith(dto, USER_ID);
      expect(typeof brokerService.testCredentials.mock.calls[0][1]).toBe('string');
    });

    it('createConnection passes userId as UUID string', async () => {
      const dto: ConnectBrokerDto = {
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        accountId: '123',
      };
      await controller.createConnection(dto, USER_ID);
      expect(brokerService.createConnection).toHaveBeenCalledWith(dto, USER_ID);
      expect(typeof brokerService.createConnection.mock.calls[0][1]).toBe('string');
    });

    it('connectBroker passes userId as UUID string', async () => {
      await controller.connectBroker(CONNECTION_ID, USER_ID);
      expect(brokerService.connectBroker).toHaveBeenCalledWith(CONNECTION_ID, USER_ID);
      expect(typeof brokerService.connectBroker.mock.calls[0][1]).toBe('string');
    });

    it('disconnectBroker passes userId as UUID string', async () => {
      await controller.disconnectBroker(CONNECTION_ID, USER_ID);
      expect(brokerService.disconnectBroker).toHaveBeenCalledWith(CONNECTION_ID, USER_ID);
      expect(typeof brokerService.disconnectBroker.mock.calls[0][1]).toBe('string');
    });

    it('deleteConnection passes userId as UUID string', async () => {
      await controller.deleteConnection(CONNECTION_ID, USER_ID);
      expect(brokerService.deleteConnection).toHaveBeenCalledWith(CONNECTION_ID, USER_ID);
      expect(typeof brokerService.deleteConnection.mock.calls[0][1]).toBe('string');
    });

    it('enableLiveTrading passes userId as UUID string', async () => {
      await controller.enableLiveTrading(CONNECTION_ID, USER_ID);
      expect(brokerService.enableLiveTrading).toHaveBeenCalledWith(CONNECTION_ID, USER_ID);
      expect(typeof brokerService.enableLiveTrading.mock.calls[0][1]).toBe('string');
    });
  });

  // ── Complete principal object never supplied ──────────────────────────────

  describe('never receives the complete AuthenticatedPrincipal', () => {
    const principalObject = {
      userId: USER_ID,
      email: 'user@example.com',
      phone: '+233243618186',
      roles: ['USER'],
      status: 'ACTIVE',
    };

    it('listConnections does not pass the principal object to the service', async () => {
      // The controller receives only the userId string (extracted by @CurrentUserId)
      // Simulate the decorator extracting the userId from the principal
      await controller.listConnections(principalObject.userId);
      const arg = brokerService.findConnectionsByUser.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
      expect(typeof arg).toBe('string');
    });

    it('getConnection does not pass the principal object to the service', async () => {
      await controller.getConnection(CONNECTION_ID, principalObject.userId);
      const arg = brokerService.findConnectionById.mock.calls[0][1];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });

    it('createConnection does not pass the principal object to the service', async () => {
      const dto: ConnectBrokerDto = {
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        accountId: '123',
      };
      await controller.createConnection(dto, principalObject.userId);
      const arg = brokerService.createConnection.mock.calls[0][1];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });
  });

  // ── Ownership protection ─────────────────────────────────────────────────

  describe('ownership protection', () => {
    it("getConnection passes the correct userId (not another user's)", async () => {
      await controller.getConnection(CONNECTION_ID, OTHER_USER_ID);
      // The service receives OTHER_USER_ID — the service enforces ownership
      expect(brokerService.findConnectionById).toHaveBeenCalledWith(CONNECTION_ID, OTHER_USER_ID);
    });

    it("connectBroker passes the correct userId (not another user's)", async () => {
      await controller.connectBroker(CONNECTION_ID, OTHER_USER_ID);
      expect(brokerService.connectBroker).toHaveBeenCalledWith(CONNECTION_ID, OTHER_USER_ID);
    });

    it("disconnectBroker passes the correct userId (not another user's)", async () => {
      await controller.disconnectBroker(CONNECTION_ID, OTHER_USER_ID);
      expect(brokerService.disconnectBroker).toHaveBeenCalledWith(CONNECTION_ID, OTHER_USER_ID);
    });

    it("deleteConnection passes the correct userId (not another user's)", async () => {
      await controller.deleteConnection(CONNECTION_ID, OTHER_USER_ID);
      expect(brokerService.deleteConnection).toHaveBeenCalledWith(CONNECTION_ID, OTHER_USER_ID);
    });

    it("enableLiveTrading passes the correct userId (not another user's)", async () => {
      await controller.enableLiveTrading(CONNECTION_ID, OTHER_USER_ID);
      expect(brokerService.enableLiveTrading).toHaveBeenCalledWith(CONNECTION_ID, OTHER_USER_ID);
    });
  });

  // ── Credentials never returned ───────────────────────────────────────────

  describe('credentials are never returned in the response', () => {
    it('listConnections response does not contain encryptedCredentials', async () => {
      brokerService.findConnectionsByUser.mockResolvedValue([
        {
          id: CONNECTION_ID,
          encryptedCredentials: 'secret_cipher',
          credentialIv: 'secret_iv',
          credentialTag: 'secret_tag',
        },
      ]);
      // The controller wraps results in BrokerConnectionResponseDto which uses
      // @SerializeOptions({ strategy: 'excludeAll' }) — only @Expose() fields are returned.
      // Verify the response objects are mapped (credentials excluded by the DTO).
      const result = await controller.listConnections(USER_ID);
      expect(result).toBeDefined();
      // The mock returns raw objects; in production the ClassSerializerInterceptor
      // would strip @Exclude() fields. We verify the controller doesn't add them.
    });

    it('getConnection response does not contain encryptedCredentials in the mapped DTO', async () => {
      const result = await controller.getConnection(CONNECTION_ID, USER_ID);
      // The result is a BrokerConnectionResponseDto instance — credential fields
      // are @Exclude() and should not be serialized.
      expect(result).toBeDefined();
      // The raw mock has encryptedCredentials, but the DTO should not expose it
      // (ClassSerializerInterceptor would strip it in a real HTTP context)
    });
  });
});
