import {
  OWNER_DEMO_NOON_LOT_TRIAL_END,
  OWNER_DEMO_NOON_LOT_TRIAL_REQUESTED_MAX_LOTS,
  OWNER_DEMO_NOON_LOT_TRIAL_STOP_RISK_SCREEN_PERCENT,
  ownerPepperstoneDemoNoonLotTrial,
} from './owner-pepperstone-demo-noon-lot-trial';
const account = {
  enabled: true,
  userId: 'owner',
  configuredOwnerId: 'owner',
  brokerConnectionId: 'pepperstone-usd-demo',
  configuredBrokerConnectionId: 'pepperstone-usd-demo',
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  accountCurrency: 'USD',
  now: new Date('2026-11-20T04:00:00.000Z'),
};
describe('owner Pepperstone USD DEMO short-lived 4+ lot trial', () => {
  it('requests up to 6 lots and .75% pre-screen only within Nov20 GMT hours', () => {
    const x = ownerPepperstoneDemoNoonLotTrial(account);
    expect(x.eligible).toBe(true);
    expect(x.maxRequestedLots).toBe(OWNER_DEMO_NOON_LOT_TRIAL_REQUESTED_MAX_LOTS);
    expect(x.maximumPrescreenRiskPercent).toBe(OWNER_DEMO_NOON_LOT_TRIAL_STOP_RISK_SCREEN_PERCENT);
    expect(x.endsAt).toBe(OWNER_DEMO_NOON_LOT_TRIAL_END);
    expect(x.noLiveAuthority).toBe(true);
    expect(x.requiresActualBrokerRiskApproval).toBe(true);
  });
  it('at exactly 12 noon Ghana/UTC automatically reverts to the original caps', () => {
    const x = ownerPepperstoneDemoNoonLotTrial({
      ...account,
      now: new Date('2026-11-20T12:00:00Z'),
    });
    expect(x.eligible).toBe(false);
    expect(x.maxRequestedLots).toBe(4);
    expect(x.maximumPrescreenRiskPercent).toBe(0.25);
    for (const at of ['2026-11-21T01:00:00Z', '2026-11-20T03:56:59.999Z']) {
      expect(ownerPepperstoneDemoNoonLotTrial({ ...account, now: new Date(at) }).eligible).toBe(
        false,
      );
    }
  });
  it('cannot transfer to live, other brokers, owner, account, or currency', () => {
    const failures: Record<string, any>[] = [
      { accountType: 'LIVE' },
      { brokerId: 'icmarkets-ctrader' },
      { accountCurrency: 'EUR' },
      { userId: 'other-user' },
      { brokerConnectionId: 'other-demo' },
      { configuredOwnerId: '' },
      { configuredBrokerConnectionId: '' },
      { enabled: false },
      { now: new Date(NaN) },
    ];
    for (const bad of failures) {
      const x = ownerPepperstoneDemoNoonLotTrial({ ...account, ...bad });
      expect(x.eligible).toBe(false);
      expect(x.maxRequestedLots).toBe(4);
      expect(x.maximumPrescreenRiskPercent).toBe(0.25);
    }
  });
});
