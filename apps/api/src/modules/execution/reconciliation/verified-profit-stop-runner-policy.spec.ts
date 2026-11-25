import {
  evaluateVerifiedProfitRunnerHold as decide,
  type VerifiedProfitRunnerInput,
} from './verified-profit-stop-runner-policy';
import { CANDLE_AWARE_EXIT_SHADOW_ARTIFACT } from './candle-aware-profit-patience-shadow';
const at = new Date('2026-11-23T12:15:00.000Z');
const candle = {
  artifact: CANDLE_AWARE_EXIT_SHADOW_ARTIFACT,
  mode: 'SHADOW_ONLY' as const,
  reason: 'SAME_DIRECTION_PULLBACK_CANDIDATE' as const,
  wouldResearchProtectedGrace: true,
  maxGraceSeconds: 180 as const,
  needsBrokerAcknowledgedPositiveStop: true as const,
  noTradeAuthority: true as const,
  changesLiveExit: false as const,
  asOf: at.toISOString(),
  m1CompletedBars: 2,
  m5Aligned: true as const,
  grossGivebackFraction: 0.12,
};
const base: VerifiedProfitRunnerInput = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  accountCurrency: 'USD',
  userId: 'owner',
  ownerUserId: 'owner',
  tradeBrokerConnectionId: 'demo-connection',
  ledgerBrokerConnectionId: 'demo-connection',
  tradeProviderPositionId: 'position-123',
  ledgerProviderPositionId: 'position-123',
  brokerProviderPositionId: 'position-123',
  direction: 'SELL',
  brokerDirection: 'SELL',
  tradeLots: 0.1,
  brokerLots: 0.1,
  now: at,
  holdStartedAt: new Date(at.getTime() - 1000),
  brokerReadbackAt: at,
  entryPrice: 159.072,
  currentBrokerMark: 159.042,
  originalStop: 159.119,
  ledgerProposedStop: 159.06,
  authoritativeStop: 159.06,
  brokerReadbackStop: 159.06,
  takeProfit: 158.989,
  brokerReadbackTakeProfit: 158.989,
  brokerNetPnl: 16,
  netFloorAfterCosts: 4,
  initialRiskPnl: 25,
  estimatedExitCostsUsd: 1,
  adverseSlippageReserveUsd: 0.2,
  independentExpertConfirmedOpposite: false,
  ledgerState: 'AUTHORITY_COMMITTED',
  brokerAcceptedAt: new Date(at.getTime() - 6000),
  brokerVerifiedAt: new Date(at.getTime() - 4500),
  authorityCommittedAt: new Date(at.getTime() - 3000),
  ledgerExpiresAt: new Date(at.getTime() + 240000),
  candle,
};
describe('DEMO broker-side confirmed profit stop bounded hold governor', () => {
  it('conditionally permits only an already broker-protected continuation', () => {
    expect(decide(base)).toMatchObject({
      decision: 'HOLD_PROTECTED',
      maxHoldSeconds: 180,
      mustRecheckWithinSeconds: 5,
      noBrokerOrderActions: true,
      liveExecutionAuthorized: false,
    });
  });
  it.each([
    ['unverified LIVE mode', { accountType: 'LIVE' }],
    ['wrong user', { ownerUserId: 'someone-else' }],
    ['wrong broker connection', { ledgerBrokerConnectionId: 'another' }],
    ['wrong provider position', { brokerProviderPositionId: 'another' }],
    ['lot mismatch', { brokerLots: 0.2 }],
    ['broker stop not amended', { brokerReadbackStop: 159.119 }],
    ['internal stop not synced', { authoritativeStop: 159.119 }],
    ['TP changed by broker', { brokerReadbackTakeProfit: 158.999 }],
    ['broker readback stale', { brokerReadbackAt: new Date(at.getTime() - 10000) }],
    ['broker ACK missing', { brokerAcceptedAt: null }],
    ['authority not committed', { ledgerState: 'ACKNOWLEDGED' as const }],
    ['expired ledger', { ledgerExpiresAt: new Date(at.getTime() - 1) }],
    [
      'opposing M5 evidence',
      {
        candle: {
          ...candle,
          m5Aligned: false,
          reason: 'M5_OPPOSES_TRADE' as const,
          wouldResearchProtectedGrace: false,
        },
      },
    ],
    [
      'stale candle advice',
      { candle: { ...candle, asOf: new Date(at.getTime() - 9000).toISOString() } },
    ],
    ['not enough net floor', { netFloorAfterCosts: 0.01 }],
    ['net profit touched protected floor', { brokerNetPnl: 3 }],
    ['independent expert confirmed opposite', { independentExpertConfirmedOpposite: true }],
    ['claimed floor exceeds independently computed stop profit', { netFloorAfterCosts: 18 }],
    ['adverse slippage leaves stop unprofitable', { adverseSlippageReserveUsd: 20 }],
    ['broker accepted after hold began', { holdStartedAt: new Date(at.getTime() - 9500) }],
    ['broker accepted in the future', { brokerAcceptedAt: new Date(at.getTime() + 1000) }],
    ['readback predates authority commit', { brokerReadbackAt: new Date(at.getTime() - 5500) }],
    ['180 second hold expired', { holdStartedAt: new Date(at.getTime() - 180000) }],
  ])('requires immediate CLOSE when %s', (_title, delta) => {
    expect(decide({ ...base, ...delta })).toMatchObject({
      decision: 'CLOSE_NOW',
      noBrokerOrderActions: true,
      liveExecutionAuthorized: false,
    });
  });
});
