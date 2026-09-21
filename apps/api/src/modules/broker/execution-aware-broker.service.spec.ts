import { ExecutionAwareBrokerService } from './execution-aware-broker.service';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAuthorizationStatus } from './authorization/broker-authorization-status';
import { BrokerMode } from './interfaces/broker-adapter.interface';

const service = Object.create(ExecutionAwareBrokerService.prototype) as ExecutionAwareBrokerService;

function executable(connection: Partial<BrokerConnection>): boolean {
  return service.isConnectionExecutable(connection as BrokerConnection);
}

describe('ExecutionAwareBrokerService paper simulator execution boundary', () => {
  it.each([
    // DEMO validation authority: a paper-broker handshake settles at CONNECTED
    // (pre-validation) — the connection IS the simulator, so simulation may
    // start from CONNECTED without the DEMO validation checklist.
    BrokerAuthorizationStatus.CONNECTED,
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.READY,
    BrokerAuthorizationStatus.ACTIVE,
  ])('allows paper-broker DEMO in %s', (authorizationStatus) => {
    expect(
      executable({
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        authorizationStatus,
      }),
    ).toBe(true);
  });

  it('keeps a real-broker DEMO connection ACTIVE-only (a handshake never authorizes execution)', () => {
    // DEMO validation authority: for real brokers even AUTHORIZED (a PASSED
    // checklist) is not executable — only the explicit LIVE enablement path
    // (ACTIVE) executes. CONNECTED (the post-handshake pre-validation state)
    // is equally non-executable.
    expect(
      executable({
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
      }),
    ).toBe(false);
    expect(
      executable({
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
      }),
    ).toBe(false);
  });

  it('does not give a LIVE paper-broker row the simulator exception', () => {
    expect(
      executable({
        brokerId: 'paper-broker',
        accountType: BrokerMode.LIVE,
        authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
      }),
    ).toBe(false);
  });

  it('keeps a paper-broker row with a pre-connect authorization state non-executable', () => {
    // CONNECTING / NOT_CONNECTED / DISCONNECTED / ERROR / SUSPENDED / REVOKED
    // are not simulation-ready states even for the paper broker.
    for (const authorizationStatus of [
      BrokerAuthorizationStatus.NOT_CONNECTED,
      BrokerAuthorizationStatus.CONNECTING,
      BrokerAuthorizationStatus.DISCONNECTED,
      BrokerAuthorizationStatus.ERROR,
      BrokerAuthorizationStatus.SUSPENDED,
      BrokerAuthorizationStatus.REVOKED,
    ]) {
      expect(
        executable({
          brokerId: 'paper-broker',
          accountType: BrokerMode.DEMO,
          authorizationStatus,
        }),
      ).toBe(false);
    }
  });

  it('retains ACTIVE execution for real broker connections', () => {
    expect(
      executable({
        brokerId: 'metatrader5',
        accountType: BrokerMode.LIVE,
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      }),
    ).toBe(true);
    // The base gate stays ACTIVE-only for every non-paper identity — a
    // real-broker DEMO row at ACTIVE (possible only via explicit operator
    // action) executes exactly like the LIVE row.
    expect(
      executable({
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      }),
    ).toBe(true);
  });
});
