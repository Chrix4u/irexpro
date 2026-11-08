import { isDeferredCtraderWeekendRouteFailure } from './ctrader-weekend-route-health.policy';
import { BrokerAuthorizationStatus } from './broker-authorization-status';
import { BrokerCredentialStatus } from './broker-credential-status';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';

const verifiedDemo = {
  brokerId: 'ctrader',
  accountType: BrokerMode.DEMO,
  status: BrokerConnectionStatus.CONNECTED,
  authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
  credentialStatus: BrokerCredentialStatus.VERIFIED,
  demoValidated: true,
};

const weekend = new Date('2026-11-07T06:27:00.000Z');
const open = new Date('2026-11-08T22:30:00.000Z');

describe('cTrader weekend provider routing grace', () => {
  it('recognizes the exact observed Saturday DEMO transport routing failure', () => {
    expect(
      isDeferredCtraderWeekendRouteFailure(
        verifiedDemo,
        new Error('Cannot route request'),
        weekend,
      ),
    ).toBe(true);
  });

  it('never suppresses an error after forex reopening', () => {
    expect(
      isDeferredCtraderWeekendRouteFailure(verifiedDemo, new Error('Cannot route request'), open),
    ).toBe(false);
  });

  it.each([
    'Trading account is not authorized',
    'Account credentials expired',
    'Environment mismatch',
    'Invalid cTrader token',
    'Could not route request',
  ])('never exempts explicit auth/security or unrecognized errors: %s', (message) => {
    expect(isDeferredCtraderWeekendRouteFailure(verifiedDemo, new Error(message), weekend)).toBe(
      false,
    );
  });

  it('never exempts a LIVE, previously suspended, revoked or unvalidated connection', () => {
    const changes = [
      { accountType: BrokerMode.LIVE },
      { authorizationStatus: BrokerAuthorizationStatus.CONNECTED },
      { authorizationStatus: BrokerAuthorizationStatus.SUSPENDED },
      { authorizationStatus: BrokerAuthorizationStatus.REVOKED },
      { status: BrokerConnectionStatus.SUSPENDED },
      { demoValidated: false },
      { credentialStatus: BrokerCredentialStatus.INVALID },
      { brokerId: 'oanda' },
    ];
    for (const patch of changes) {
      expect(
        isDeferredCtraderWeekendRouteFailure(
          { ...verifiedDemo, ...patch },
          new Error('Cannot route request'),
          weekend,
        ),
      ).toBe(false);
    }
  });
});
