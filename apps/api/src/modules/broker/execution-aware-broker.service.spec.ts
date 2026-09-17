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

  it('keeps a real-broker DEMO connection ACTIVE-only', () => {
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

  it('retains ACTIVE execution for real broker connections', () => {
    expect(
      executable({
        brokerId: 'metatrader5',
        accountType: BrokerMode.LIVE,
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      }),
    ).toBe(true);
  });
});
