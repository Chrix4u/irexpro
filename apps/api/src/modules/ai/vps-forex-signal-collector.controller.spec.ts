import { VpsForexSignalCollectorController } from './vps-forex-signal-collector.controller';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';
import { BrokerParityV7Service } from './broker-parity-v7.service';
import { V8DedicatedPaperReadinessService } from './v8-dedicated-paper-readiness.service';
import { M1TacticalSchedulerService } from './m1-tactical-scheduler.service';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

describe('VpsForexSignalCollectorController', () => {
  it('scopes status to the authenticated user and exposes no configuration secrets', async () => {
    const getStatus = jest.fn().mockResolvedValue({
      providerCode: 'vps-twelvedata-six-pair-v7',
      enabled: false,
      configured: false,
      state: 'WAITING_FOR_CONFIGURATION',
      paperOnly: true,
    });
    const controller = new VpsForexSignalCollectorController(
      { getStatus } as unknown as VpsForexSignalCollectorService,
      {} as BrokerParityV7Service,
      {} as V8DedicatedPaperReadinessService,
      {} as M1TacticalSchedulerService,
      {} as M1TacticalEvidenceService,
    );

    const result = await controller.getStatus('user-1');

    expect(getStatus).toHaveBeenCalledWith('user-1');
    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('brokerConnectionId');
  });
  it('returns the authenticated user latest M1 tactical decision with scheduler runtime', async () => {
    const schedulerStatus = {
      enabled: true,
      phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
      lastRunAt: '2026-10-27T20:30:09.000Z',
      lastError: null,
      marketReadiness: { EURUSD: { ready: true, reason: 'READY' } },
    };
    const latestDecision = {
      instrument: 'EURUSD',
      direction: 'SELL',
      route: 'M1_TREND_CONTINUATION',
      barTime: '2026-10-27T20:29:00.000Z',
      confidence: 0.738,
      netExpectedR: 0.2794,
      executionAuthority: 'NONE',
      blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'M1_PHASE_ROUTE_SHADOW'],
      outcomeState: null,
    };
    const controller = new VpsForexSignalCollectorController(
      {} as VpsForexSignalCollectorService,
      {} as BrokerParityV7Service,
      {} as V8DedicatedPaperReadinessService,
      { getStatus: jest.fn().mockReturnValue(schedulerStatus) } as unknown as M1TacticalSchedulerService,
      { loadLatestDecisionStateForUser: jest.fn().mockResolvedValue(latestDecision) } as unknown as M1TacticalEvidenceService,
    );

    await expect(controller.getM1TacticalStatus('user-1')).resolves.toEqual({
      ...schedulerStatus,
      latestDecision,
    });
  });

});
