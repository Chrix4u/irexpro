import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { evaluateCtraderStopDistanceProof } from './ctrader-native-min-stop-distance-shadow';
import { DemoProfitStopAuthoritySyncService } from './demo-profit-stop-authority-sync.service';

/**
 * Owner Pepperstone USD DEMO only; no controller, job, or timer subscribes.
 * Explicitly DISABLED in runtime until a guarded owner-DEMO pilot.
 * PREPARED and DISPATCHING are durable DB states before any 2110 network I/O.
 * BrokerService owns exactly one provider amendment with native SL/TP checks;
 * authoritySync then independently reads Pepperstone and commits the trade
 * stop+ledger in the same transaction. A success is NOT itself a HOLD: the
 * 5-second candle-aware governor must additionally prove current conditions.
 */
export type ProtectedStopActivationResult = {
  status: 'DISABLED' | 'INELIGIBLE' | 'PREPARED_AND_BROKER_VERIFIED' | 'UNRESOLVED';
  ledgerId: string | null;
  reason: string;
  permitsProfitCloseDeferral: false;
  permitsLiveOrders: false;
};

export interface OwnerDemoStopCandidate {
  userId: string;
  brokerConnectionId: string;
  tradeId: string;
  brokerPositionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: 'EARLY_TRANSITION' | 'CONFIRMED_REVERSAL';
  tradeLots: string;
  entryPrice: string;
  originalStop: string;
  originalTakeProfit: string;
  proposedPositiveStop: string;
  estimatedExitCostReserve: string;
  estimatedNetFloorAfterReserve: string;
}

const samePrice = (a: string, b: string) =>
  Number.isFinite(Number(a)) &&
  Number.isFinite(Number(b)) &&
  Math.abs(Number(a) - Number(b)) < 1e-8;

@Injectable()
export class DemoProtectedProfitRunnerOrchestrator {
  constructor(
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
    private readonly authoritySync: DemoProfitStopAuthoritySyncService,
  ) {}

  async prepareAndCommitVerifiedPositiveStop(
    candidate: OwnerDemoStopCandidate,
  ): Promise<ProtectedStopActivationResult> {
    const result = (
      status: ProtectedStopActivationResult['status'],
      reason: string,
      ledgerId: string | null = null,
    ): ProtectedStopActivationResult => ({
      status,
      reason,
      ledgerId,
      permitsProfitCloseDeferral: false,
      permitsLiveOrders: false,
    });
    if (
      process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION !== 'enabled' ||
      process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND !== 'enabled' ||
      process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC !== 'enabled'
    ) {
      return result('DISABLED', 'EXECUTOR_FEATURE_FLAGS_NOT_ENABLED');
    }
    if (
      !process.env.VPS_FOREX_SCANNER_USER_ID ||
      candidate.userId !== process.env.VPS_FOREX_SCANNER_USER_ID ||
      !['EARLY_TRANSITION', 'CONFIRMED_REVERSAL'].includes(candidate.strategyRoute) ||
      !['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY', 'USDCAD', 'USDCHF'].includes(
        candidate.instrument,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(candidate.tradeId) ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(candidate.brokerConnectionId) ||
      !candidate.brokerPositionId ||
      !Number.isFinite(Number(candidate.tradeLots)) ||
      Number(candidate.tradeLots) <= 0 ||
      !Number.isFinite(Number(candidate.estimatedExitCostReserve)) ||
      Number(candidate.estimatedExitCostReserve) <= 0 ||
      !Number.isFinite(Number(candidate.estimatedNetFloorAfterReserve)) ||
      Number(candidate.estimatedNetFloorAfterReserve) <= 0
    ) {
      return result('INELIGIBLE', 'OWNER_ROUTE_OR_COST_EVIDENCE_UNVERIFIED');
    }
    const snapshot = await this.brokerService.getOpenPositionsForConnection(
      candidate.brokerConnectionId,
      candidate.userId,
    );
    if (
      snapshot.connection.userId !== candidate.userId ||
      snapshot.connection.id !== candidate.brokerConnectionId ||
      snapshot.connection.brokerId !== 'pepperstone-ctrader' ||
      snapshot.connection.accountType !== 'DEMO' ||
      snapshot.connection.accountCurrency !== 'USD'
    ) {
      return result('INELIGIBLE', 'BROKER_CONNECTION_OR_MODE_UNVERIFIED');
    }
    const matching = snapshot.positions.filter(
      (p) => p.externalOrderId === candidate.brokerPositionId,
    );
    if (matching.length !== 1) return result('INELIGIBLE', 'POSITION_IDENTITY_UNVERIFIED');
    const p = matching[0];
    if (
      p.instrument !== candidate.instrument ||
      p.direction !== candidate.direction ||
      !samePrice(p.lotSize, candidate.tradeLots) ||
      !samePrice(p.openPrice, candidate.entryPrice) ||
      !samePrice(p.stopLoss, candidate.originalStop) ||
      !samePrice(p.takeProfit, candidate.originalTakeProfit)
    ) {
      return result('INELIGIBLE', 'BROKER_POSITION_ORIGINAL_PROTECTION_MISMATCH');
    }
    const [symbol, quote] = await Promise.all([
      this.brokerService.getInstrumentSpecForConnection(
        candidate.userId,
        candidate.brokerConnectionId,
        candidate.instrument,
      ),
      this.brokerService.getCurrentPriceForConnection(
        candidate.userId,
        candidate.brokerConnectionId,
        candidate.instrument,
      ),
    ]);
    const now = new Date();
    const proof = evaluateCtraderStopDistanceProof({
      ownerDemoVerified: true,
      brokerId: snapshot.connection.brokerId,
      accountType: snapshot.connection.accountType,
      currency: 'USD',
      instrument: candidate.instrument,
      direction: candidate.direction,
      entryPrice: Number(candidate.entryPrice),
      originalStop: Number(candidate.originalStop),
      originalTakeProfit: Number(candidate.originalTakeProfit),
      proposedStop: Number(candidate.proposedPositiveStop),
      lastBid: quote ? Number(quote.bid) : null,
      lastAsk: quote ? Number(quote.ask) : null,
      quoteObservedAt: quote?.timestamp ?? null,
      observedAt: now,
      symbol,
    });
    if (!proof.candidateMeetsAdvertisedMinDistance || !quote) {
      return result('INELIGIBLE', `PROVIDER_STOP_PREFLIGHT_${proof.reason}`);
    }
    const entry = Number(candidate.entryPrice),
      stop = Number(candidate.originalStop),
      amended = Number(candidate.proposedPositiveStop);
    const riskDistance = Math.abs(entry - stop),
      lockedPrice = Math.abs(entry - amended);
    // Screen only. A stop can gap or slip; final hold governor independently
    // rechecks the fee reserve and broker-reported stop every 5 seconds.
    const estimatedRisk = (await this.dataSource.query(
      `SELECT t.id,t.lot_size::text,
              COALESCE(NULLIF(ca.sizing_inputs->>'finalRiskAtStop','')::numeric,
                       NULLIF(ca.sizing_inputs->>'riskAmount','')::numeric)::text
                AS initial_risk_pnl
       FROM trading.trades t
       JOIN trading.trading_sessions s ON s.id=t.trading_session_id AND s.status='ACTIVE'
       LEFT JOIN LATERAL (
         SELECT sizing_inputs FROM trading.capital_allocations ca0
         WHERE ca0.trade_intent_id=t.trade_intent_id
           AND ca0.created_at<=t.opened_at
         ORDER BY ca0.created_at DESC LIMIT 1
       ) ca ON true
       WHERE t.id=$1 AND t.user_id=$2 AND t.broker_connection_id=$3
         AND t.status='OPEN' AND t.account_currency='USD'`,
      [candidate.tradeId, candidate.userId, candidate.brokerConnectionId],
    )) as Array<{ initial_risk_pnl: string }>;
    const r = Number(estimatedRisk[0]?.initial_risk_pnl);
    const impliedNet =
      (r * lockedPrice) / riskDistance -
      Number(candidate.estimatedExitCostReserve) -
      Math.max(r * 0.02, 0.2);
    if (
      estimatedRisk.length !== 1 ||
      !Number.isFinite(r) ||
      r <= 0 ||
      !Number.isFinite(impliedNet) ||
      impliedNet < Math.max(0.1 * r, 1) ||
      Number(candidate.estimatedNetFloorAfterReserve) > impliedNet + 0.01
    ) {
      return result('INELIGIBLE', 'PROTECTED_NET_FLOOR_NOT_COVERED_BY_RISK_GEOMETRY');
    }
    // A UNIQUE, short-lived, one-per-trade ledger ID is reserved before
    // any provider modification. SQL validates all owner/trade/session/model
    // predicates again to defend against stale caller snapshots.
    const rows = (await this.dataSource.query(
      `INSERT INTO trading.demo_profit_stop_amendment_intents
        (user_id,trade_id,broker_connection_id,broker_id,account_type,
         account_currency,strategy_route,broker_position_id,client_request_id,
         instrument,direction,trade_lots,entry_price,original_stop,
         original_take_profit,proposed_positive_stop,broker_quote_bid,
         broker_quote_ask,broker_quote_at,estimated_exit_cost_reserve,
         estimated_net_floor_after_reserve,state,expires_at)
       SELECT t.user_id,t.id,t.broker_connection_id,b.broker_id,b.account_type,
              t.account_currency,$4::text,$5::text,$6::text,t.instrument,t.direction,t.lot_size,
              t.fill_price,t.stop_loss,t.take_profit,$7::numeric,
              $8::numeric,$9::numeric,$10::timestamptz,$11::numeric,
              $12::numeric,'PREPARED',$10::timestamptz+interval '180 seconds'
         FROM trading.trades t
         JOIN broker.broker_connections b ON b.id=t.broker_connection_id
         JOIN trading.trading_sessions s ON s.id=t.trading_session_id AND s.status='ACTIVE'
         LEFT JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
        WHERE t.id=$1 AND t.user_id=$2 AND t.broker_connection_id=$3
          AND t.status='OPEN' AND b.status='CONNECTED'
          AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
          AND b.account_currency='USD' AND t.account_currency='USD'
          AND ti.metadata->>'multimodel_plan_b_route'=$4::text
          AND COALESCE(t.external_position_id,t.external_order_id)=$5::text
          AND t.instrument=$13 AND t.direction=$14
          AND t.lot_size=$15::numeric AND t.fill_price=$16::numeric
          AND t.stop_loss=$17::numeric AND t.take_profit=$18::numeric
          AND NOT EXISTS (SELECT 1 FROM trading.demo_profit_stop_amendment_intents prior
                          WHERE prior.trade_id=t.id)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        candidate.tradeId,
        candidate.userId,
        candidate.brokerConnectionId,
        candidate.strategyRoute,
        candidate.brokerPositionId,
        `protected-runner-${candidate.tradeId}`,
        candidate.proposedPositiveStop,
        quote.bid,
        quote.ask,
        quote.timestamp.toISOString(),
        candidate.estimatedExitCostReserve,
        candidate.estimatedNetFloorAfterReserve,
        candidate.instrument,
        candidate.direction,
        candidate.tradeLots,
        candidate.entryPrice,
        candidate.originalStop,
        candidate.originalTakeProfit,
      ],
    )) as Array<{ id: string }>;
    if (rows.length !== 1) return result('INELIGIBLE', 'PROTECTED_RUNNER_LEDGER_ALREADY_EXISTS');
    const ledgerId = rows[0].id;
    const prepared = (await this.dataSource.query(
      `UPDATE trading.demo_profit_stop_amendment_intents
          SET state='DISPATCHING',updated_at=clock_timestamp()
        WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3
          AND state='PREPARED' AND expires_at>clock_timestamp()
        RETURNING id`,
      [ledgerId, candidate.userId, candidate.brokerConnectionId],
    )) as Array<{ id: string }>;
    if (prepared.length !== 1) return result('UNRESOLVED', 'LEDGER_DISPATCH_CAS_FAILED', ledgerId);
    try {
      await this.brokerService.amendVerifiedOwnerDemoProfitStop({
        userId: candidate.userId,
        connectionId: candidate.brokerConnectionId,
        ledgerId,
      });
      const commit = await this.authoritySync.commitVerifiedStop(candidate.userId, ledgerId);
      if (commit.state !== 'AUTHORITY_COMMITTED') {
        return result('UNRESOLVED', 'BROKER_STOP_AUTHORITY_NOT_COMMITTED', ledgerId);
      }
      // This function only installs protective authority, not a hold.
      // Separate as-of M1/M5 and broker-readback exit governor owns the choice.
      return result(
        'PREPARED_AND_BROKER_VERIFIED',
        'STOP_ACK_READBACK_AND_TRADE_AUTHORITY_COMMITTED',
        ledgerId,
      );
    } catch {
      // Never repeat an uncertain 2110 amendment or silently restore the
      // weaker original SL. The gateway quarantines uncertain dispatches.
      return result('UNRESOLVED', 'BROKER_STOP_AMEND_OR_AUTHORITY_SYNC_UNPROVEN', ledgerId);
    }
  }
}
