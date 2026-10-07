import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerMode } from '../../broker/interfaces/broker-adapter.interface';
import { Trade, TradeStatus } from '../../execution/entities/trade.entity';
import { getMinorUnitDigits } from '../../broker-reconciliation/services/currency-minor-units';
import { majorToMinorUnits } from '../../broker-reconciliation/services/closed-trade-normalizer.service';
import { PerformanceFeeSimulationState } from '../entities/performance-fee-simulation-state.entity';
import {
  PerformanceFeeSimulationCharge,
  SimulationChargeStatus,
  SimulationSourceMode,
} from '../entities/performance-fee-simulation-charge.entity';
import { PerformanceFeeService } from './performance-fee.service';
import { calculateHighWaterMarkFee } from './performance-fee-calculation';

export interface SimulationSnapshot {
  brokerConnectionId: string;
  brokerId: string;
  brokerName: string;
  displayName: string | null;
  sourceMode: SimulationSourceMode;
  currency: string;
  simulationActive: boolean;
  simulationStartedAt: string | null;
  closedTradeCount: number;
  firstClosedAt: string | null;
  lastClosedAt: string | null;
  cumulativeRealisedMinor: string;
  currentHighWaterMarkMinor: string;
  profitAboveHighWaterMarkMinor: string;
  currentSimulatedFeeMinor: string;
  totalFeesSimulatedMinor: string;
  policy: {
    id: string;
    name: string;
    feePercent: string;
    billingFrequency: string;
    calculationMode: string;
  } | null;
  currentCharge: PerformanceFeeSimulationCharge | null;
  recentCharges: PerformanceFeeSimulationCharge[];
  nonPayable: true;
}

@Injectable()
export class PerformanceFeeSimulationService {
  constructor(
    @InjectRepository(PerformanceFeeSimulationState)
    private readonly stateRepo: Repository<PerformanceFeeSimulationState>,
    @InjectRepository(PerformanceFeeSimulationCharge)
    private readonly chargeRepo: Repository<PerformanceFeeSimulationCharge>,
    @InjectRepository(BrokerConnection)
    private readonly brokerRepo: Repository<BrokerConnection>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly performanceFeeService: PerformanceFeeService,
    private readonly dataSource: DataSource,
  ) {}

  async getUserSimulation(userId: string): Promise<{
    mode: 'TEST_ONLY';
    paymentEnabled: false;
    accounts: SimulationSnapshot[];
  }> {
    const connections = await this.brokerRepo.find({
      where: { userId, accountType: BrokerMode.DEMO },
      order: { createdAt: 'DESC' },
    });

    const accounts: SimulationSnapshot[] = [];
    for (const connection of connections) {
      accounts.push(await this.buildSnapshot(userId, connection));
    }
    return { mode: 'TEST_ONLY', paymentEnabled: false, accounts };
  }
  async refresh(userId: string, brokerConnectionId: string): Promise<SimulationSnapshot> {
    const connection = await this.requireDemoConnection(userId, brokerConnectionId);
    const before = await this.buildSnapshot(userId, connection);

    // First refresh establishes a clean test baseline at the account's current
    // cumulative realised P&L. Old PAPER/DEMO history is therefore not
    // retroactively billed; only profit realised after the test begins is
    // evaluated. This state is isolated from the LIVE performance ledger.
    if (!before.simulationActive) {
      const state = this.stateRepo.create({
        userId,
        brokerConnectionId,
        currency: before.currency,
        currentHighWaterMark: before.cumulativeRealisedMinor,
        totalFeesSimulated: '0',
        lastSettledRealisedBalance: before.cumulativeRealisedMinor,
        lastSimulatedSettlementAt: null,
      });
      await this.stateRepo.save(state);
      return this.buildSnapshot(userId, connection);
    }

    if (!before.policy || BigInt(before.currentSimulatedFeeMinor) <= 0n) {
      return before;
    }
    if (before.currentCharge) return before;

    const charge = this.chargeRepo.create({
      userId,
      brokerConnectionId,
      sourceMode: this.sourceMode(connection),
      currency: before.currency,
      periodStart: before.firstClosedAt ? new Date(before.firstClosedAt) : null,
      periodEnd: before.lastClosedAt ? new Date(before.lastClosedAt) : null,
      tradeCount: before.closedTradeCount,
      startingHighWaterMark: before.currentHighWaterMarkMinor,
      endingRealisedBalance: before.cumulativeRealisedMinor,
      realisedProfitForFee: before.profitAboveHighWaterMarkMinor,
      feePercent: before.policy.feePercent,
      feeAmount: before.currentSimulatedFeeMinor,
      status: SimulationChargeStatus.DUE_TEST,
      simulatedSettledAt: null,
      metadata: {
        testOnly: true,
        nonPayable: true,
        policyId: before.policy.id,
        policyName: before.policy.name,
        billingFrequency: before.policy.billingFrequency,
        calculationMode: before.policy.calculationMode,
        note: 'PAPER/DEMO fee simulation only. No payment transaction or real debt is created.',
      },
    });
    await this.chargeRepo.save(charge);
    return this.buildSnapshot(userId, connection);
  }

  async settleTestCharge(userId: string, chargeId: string): Promise<SimulationSnapshot> {
    const charge = await this.chargeRepo.findOne({ where: { id: chargeId, userId } });
    if (!charge) throw new NotFoundException('Simulation charge not found');
    if (charge.status !== SimulationChargeStatus.DUE_TEST) {
      throw new BadRequestException(
        `Simulation charge is ${charge.status}; only DUE_TEST can be settled.`,
      );
    }

    const connection = await this.requireDemoConnection(userId, charge.brokerConnectionId);
    await this.dataSource.transaction(async (manager) => {
      const chargeRepo = manager.getRepository(PerformanceFeeSimulationCharge);
      const stateRepo = manager.getRepository(PerformanceFeeSimulationState);
      const lockedCharge = await chargeRepo.findOne({
        where: { id: charge.id, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedCharge || lockedCharge.status !== SimulationChargeStatus.DUE_TEST) {
        throw new BadRequestException('Simulation charge is no longer due.');
      }

      let state = await stateRepo.findOne({
        where: { userId, brokerConnectionId: charge.brokerConnectionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!state) {
        state = stateRepo.create({
          userId,
          brokerConnectionId: charge.brokerConnectionId,
          currency: charge.currency,
          currentHighWaterMark: '0',
          totalFeesSimulated: '0',
          lastSettledRealisedBalance: '0',
          lastSimulatedSettlementAt: null,
        });
      }
      if (state.currency !== charge.currency) {
        throw new BadRequestException('Simulation currency changed; reset is required.');
      }

      state.currentHighWaterMark = lockedCharge.endingRealisedBalance;
      state.lastSettledRealisedBalance = lockedCharge.endingRealisedBalance;
      state.totalFeesSimulated = (
        BigInt(state.totalFeesSimulated) + BigInt(lockedCharge.feeAmount)
      ).toString();
      state.lastSimulatedSettlementAt = new Date();
      await stateRepo.save(state);

      lockedCharge.status = SimulationChargeStatus.SETTLED_TEST;
      lockedCharge.simulatedSettledAt = new Date();
      await chargeRepo.save(lockedCharge);
    });

    return this.buildSnapshot(userId, connection);
  }

  private async buildSnapshot(
    userId: string,
    connection: BrokerConnection,
  ): Promise<SimulationSnapshot> {
    const currency = (connection.accountCurrency ?? '').toUpperCase();
    if (!currency) {
      throw new BadRequestException(
        `Demo connection ${connection.id} has no authoritative account currency.`,
      );
    }
    const digits = getMinorUnitDigits(currency);
    const trades = await this.tradeRepo.find({
      where: {
        userId,
        brokerConnectionId: connection.id,
        status: TradeStatus.CLOSED,
      },
      order: { closedAt: 'ASC' },
    });

    let cumulative = 0n;
    let firstClosedAt: Date | null = null;
    let lastClosedAt: Date | null = null;
    let countedTrades = 0;
    for (const trade of trades) {
      if (trade.realisedPnl == null || trade.closedAt == null) continue;
      if (trade.accountCurrency && trade.accountCurrency.toUpperCase() !== currency) {
        throw new BadRequestException(
          `Trade ${trade.id} currency ${trade.accountCurrency} does not match demo account ${currency}.`,
        );
      }
      const minor = majorToMinorUnits(trade.realisedPnl, digits);
      if (minor == null) {
        throw new BadRequestException(`Trade ${trade.id} has invalid realised P&L.`);
      }
      cumulative += BigInt(minor);
      countedTrades += 1;
      if (!firstClosedAt || trade.closedAt < firstClosedAt) firstClosedAt = trade.closedAt;
      if (!lastClosedAt || trade.closedAt > lastClosedAt) lastClosedAt = trade.closedAt;
    }

    const state = await this.stateRepo.findOne({
      where: { userId, brokerConnectionId: connection.id },
    });
    const currentHighWaterMark = state?.currentHighWaterMark ?? cumulative.toString();
    const totalFeesSimulated = state?.totalFeesSimulated ?? '0';

    let policy: SimulationSnapshot['policy'] = null;
    try {
      const active = await this.performanceFeeService.findActiveGlobalPolicy();
      policy = {
        id: active.id,
        name: active.name,
        feePercent: active.feePercent,
        billingFrequency: active.billingFrequency,
        calculationMode: active.calculationMode,
      };
    } catch {
      policy = null;
    }

    const calculation =
      policy && state
        ? calculateHighWaterMarkFee({
            cumulativeRealisedMinor: cumulative.toString(),
            startingHighWaterMarkMinor: currentHighWaterMark,
            feePercent: policy.feePercent,
          })
        : null;

    const currentCharge = await this.chargeRepo.findOne({
      where: {
        userId,
        brokerConnectionId: connection.id,
        status: SimulationChargeStatus.DUE_TEST,
      },
      order: { createdAt: 'DESC' },
    });
    const recentCharges = await this.chargeRepo.find({
      where: { userId, brokerConnectionId: connection.id },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    return {
      brokerConnectionId: connection.id,
      brokerId: connection.brokerId,
      brokerName: connection.brokerName,
      displayName: connection.displayName,
      sourceMode: this.sourceMode(connection),
      currency,
      simulationActive: Boolean(state),
      simulationStartedAt: state?.createdAt?.toISOString?.() ?? null,
      closedTradeCount: countedTrades,
      firstClosedAt: firstClosedAt?.toISOString() ?? null,
      lastClosedAt: lastClosedAt?.toISOString() ?? null,
      cumulativeRealisedMinor: cumulative.toString(),
      currentHighWaterMarkMinor: currentHighWaterMark,
      profitAboveHighWaterMarkMinor: calculation?.realisedProfitForFeeMinor ?? '0',
      currentSimulatedFeeMinor: calculation?.feeAmountMinor ?? '0',
      totalFeesSimulatedMinor: totalFeesSimulated,
      policy,
      currentCharge,
      recentCharges,
      nonPayable: true,
    };
  }

  private async requireDemoConnection(
    userId: string,
    brokerConnectionId: string,
  ): Promise<BrokerConnection> {
    const connection = await this.brokerRepo.findOne({
      where: { id: brokerConnectionId, userId },
    });
    if (!connection) throw new NotFoundException('Broker connection not found');
    if (connection.accountType !== BrokerMode.DEMO) {
      throw new BadRequestException(
        'Fee simulation is restricted to PAPER/DEMO connections. LIVE uses the verified billing ledger.',
      );
    }
    return connection;
  }

  private sourceMode(connection: BrokerConnection): SimulationSourceMode {
    return connection.brokerId === 'paper-broker'
      ? SimulationSourceMode.PAPER
      : SimulationSourceMode.DEMO;
  }
}
