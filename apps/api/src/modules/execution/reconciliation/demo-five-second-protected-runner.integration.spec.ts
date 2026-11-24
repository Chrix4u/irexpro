import { DataSource } from 'typeorm';
import { LiveDemoProfitProtectionService } from './live-demo-profit-protection.service';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionService } from '../execution.service';
import { DemoProtectedProfitRunnerOrchestrator } from './demo-protected-profit-runner-orchestrator.service';

const now = () => new Date();
const baseline = (at: Date) => ({
  trade_id: 'trade-1',
  user_id: 'owner-1',
  broker_connection_id: 'connection-1',
  external_position_id: 'position-123',
  external_order_id: 'position-123',
  instrument: 'USDJPY',
  direction: 'SELL',
  lot_size: '0.10',
  account_currency: 'USD',
  is_m1_strategy: true,
  strategy_route: 'EARLY_TRANSITION',
  opened_at: new Date(at.getTime() - 120000),
  max_favorable_pnl: '20',
  initial_risk_pnl: '25',
  stop_loss: '159.060',
  take_profit: '158.989',
});
const brokerPosition = (at: Date) => ({
  externalOrderId: 'position-123',
  instrument: 'USDJPY',
  direction: 'SELL',
  lotSize: '0.10',
  openPrice: '159.072',
  currentPrice: '159.043',
  stopLoss: '159.060',
  takeProfit: '158.989',
  unrealisedPnl: '16',
  commission: '-1',
  swap: '0',
  openedAt: new Date(at.getTime() - 120000),
  markIsStale: false,
});
const ledger = (at: Date) => ({
  id: 'ledger-1',
  state: 'AUTHORITY_COMMITTED',
  broker_connection_id: 'connection-1',
  broker_position_id: 'position-123',
  original_stop: '159.119',
  original_take_profit: '158.989',
  proposed_positive_stop: '159.060',
  estimated_net_floor_after_reserve: '4',
  broker_ack_at: new Date(at.getTime() - 5000),
  broker_verified_at: new Date(at.getTime() - 4000),
  authority_committed_at: new Date(at.getTime() - 2000),
  expires_at: new Date(at.getTime() + 174000),
  authoritative_stop: '159.060',
  trade_status: 'OPEN',
  session_status: 'ACTIVE',
});
const eligibleM1M5 = (at: Date) => {
  const minute = Math.floor(at.getTime() / 60000) * 60000;
  const five = Math.floor(at.getTime() / 300000) * 300000;
  return {
    m1: [
      {
        startedAt: new Date(minute - 120000),
        timeframeMinutes: 1,
        open: 159.052,
        high: 159.055,
        low: 159.045,
        close: 159.046,
        brokerNativeSampleCount: 40,
      },
      {
        startedAt: new Date(minute - 60000),
        timeframeMinutes: 1,
        open: 159.046,
        high: 159.048,
        low: 159.041,
        close: 159.043,
        brokerNativeSampleCount: 35,
      },
    ],
    m5: {
      startedAt: new Date(five - 300000),
      timeframeMinutes: 5,
      open: 159.08,
      high: 159.085,
      low: 159.04,
      close: 159.044,
      brokerNativeSampleCount: 150,
    },
  };
};
function harness(
  at: Date,
  overrides: {
    state?: string;
    sessionStatus?: string;
    brokerStop?: string;
    brokerType?: string;
    expiresAt?: Date;
  } = {},
) {
  const row = {
    ...ledger(at),
    state: overrides.state ?? 'AUTHORITY_COMMITTED',
    session_status: overrides.sessionStatus ?? 'ACTIVE',
    expires_at: overrides.expiresAt ?? ledger(at).expires_at,
  };
  const query = jest.fn().mockResolvedValue([row]);
  const broker = {
    getOpenPositionsForConnection: jest.fn().mockResolvedValue({
      connection: {
        id: 'connection-1',
        brokerId: 'pepperstone-ctrader',
        accountType: overrides.brokerType ?? 'DEMO',
        accountCurrency: 'USD',
        userId: 'owner-1',
      },
      positions: [{ ...brokerPosition(at), stopLoss: overrides.brokerStop ?? '159.060' }],
    }),
    getCurrentPriceForConnection: jest.fn().mockResolvedValue({
      instrument: 'USDJPY',
      bid: '159.041',
      ask: '159.043',
      spread: '0.002',
      timestamp: new Date(at.getTime() - 700),
    }),
  };
  const execution = { closeTrade: jest.fn() };
  const coordinator = { prepareAndCommitVerifiedPositiveStop: jest.fn() };
  const service = new LiveDemoProfitProtectionService(
    { query } as unknown as DataSource,
    broker as unknown as BrokerService,
    execution as unknown as ExecutionService,
    undefined,
    coordinator as unknown as DemoProtectedProfitRunnerOrchestrator,
  );
  const target = service as unknown as Record<string, any>;
  target.loadAsOfBrokerNativeProfitExitCandles = jest.fn().mockResolvedValue(eligibleM1M5(at));
  target.loadCausalPepperstoneDemoCostEstimate = jest
    .fn()
    .mockResolvedValue({ estimatedCost: 1, sampleCount: 8 });
  target.loadProfitLockPatienceSignal = jest.fn().mockResolvedValue({
    sameSideContinuationAt: new Date(at.getTime() - 20000),
    oppositeExecutableReversal: false,
  });
  target.loadLatestAiThesis = jest.fn().mockResolvedValue({
    direction: 'SELL',
    evaluatedAt: new Date(at.getTime() - 20000),
    executionAuthority: 'BROKER_NATIVE',
    authorityExecutable: true,
    blockers: [],
    trainedExpert: {
      allBrokerNative: true,
      direction: 'SELL',
      longVotes: 0,
      shortVotes: 3,
      ensembleConfidence: 0.82,
      freshnessSeconds: 20,
    },
  });
  target.loadCausalM1Evidence = jest.fn().mockResolvedValue({
    completedBars: 2,
    liveQuoteBars: 2,
    latestAgeSeconds: 3,
    adverseBars: 0,
    alignedLatestBodyPressure: 0.3,
    alignedMomentum3: 0.32,
  });
  return { service, target, query, broker, execution, coordinator };
}
describe('five-second owner-DEMO protected runner integration', () => {
  const envKeys = [
    'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION',
    'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND',
    'IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC',
    'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_HOLD',
    'VPS_FOREX_SCANNER_USER_ID',
  ];
  const old = envKeys.map((k) => process.env[k]);
  beforeEach(() => {
    for (const k of envKeys.slice(0, 4)) process.env[k] = 'enabled';
    process.env.VPS_FOREX_SCANNER_USER_ID = 'owner-1';
  });
  afterAll(() =>
    envKeys.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    }),
  );
  it('never manages a trade with no persisted protected-stop intent', async () => {
    const at = now(),
      h = harness(at);
    h.query.mockResolvedValue([]);
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('NONE');
    expect(h.broker.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });
  it('requires FOUR flags even if provider stop+ledger were previously committed', async () => {
    delete process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_HOLD;
    const at = now(),
      h = harness(at);
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('CLOSE');
    expect(h.broker.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });
  it.each([
    ['manual stop', { sessionStatus: 'STOPPED' }],
    ['uncertain ledger', { state: 'NEEDS_MANUAL_RECONCILIATION' }],
    ['expired window', { expiresAt: new Date(Date.now() - 2000) }],
  ])('closes before any broker call on %s', async (_reason, delta) => {
    const at = now(),
      h = harness(at, delta);
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('CLOSE');
    expect(h.broker.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });
  it('continues only when all broker, authority, trained expert, fees, and M1/M5 proofs agree', async () => {
    const at = now(),
      h = harness(at);
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('HOLD');
    expect(h.broker.getOpenPositionsForConnection).toHaveBeenCalledTimes(1);
    expect(h.execution.closeTrade).not.toHaveBeenCalled();
  });
  it('closes instead of holding if provider stop reverts to the original weaker SL', async () => {
    const at = now(),
      h = harness(at, { brokerStop: '159.119' });
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('CLOSE');
  });
  it('closes if the independent model confirms a real opposite reversal', async () => {
    const at = now(),
      h = harness(at);
    h.target.loadProfitLockPatienceSignal = jest.fn().mockResolvedValue({
      sameSideContinuationAt: new Date(at.getTime() - 20000),
      oppositeExecutableReversal: true,
    });
    expect(
      await h.target.manageExistingBrokerProtectedRunner(
        baseline(at),
        brokerPosition(at),
        at,
        16,
        20,
      ),
    ).toBe('CLOSE');
  });
  it('does not attempt a new stop without all four pilot flags', async () => {
    delete process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_HOLD;
    const at = now(),
      h = harness(at);
    expect(
      await h.target.maybeStartBrokerProtectedProfitRunner({
        trade: baseline(at),
        position: brokerPosition(at),
        observedAt: at,
        currentPnl: 16,
        maxFavorablePnl: 20,
        risk: 25,
        conservativeExitReserve: 1,
        historicalFeeSamples: 8,
      }),
    ).toBe(false);
    expect(h.coordinator.prepareAndCommitVerifiedPositiveStop).not.toHaveBeenCalled();
  });
});
