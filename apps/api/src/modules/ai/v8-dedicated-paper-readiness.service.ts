import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerService } from '../broker/broker.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { ExternalSignalPerformanceService } from './external-signal-performance.service';

const V7_PROVIDER = 'vps-twelvedata-six-pair-v7';
const V8_PROVIDER = 'v8-dedicated-paper-v1';
const V8_MODEL = 'external-provider/v8-shadow-online-meta-v1/dedicated-paper-v1';

type V8PaperState =
  | 'DISABLED'
  | 'WAITING_FOR_CONFIGURATION'
  | 'TARGET_NOT_ISOLATED'
  | 'COLLECTING_PROSPECTIVE_SHADOW'
  | 'WAITING_FOR_FROZEN_ARTIFACT'
  | 'READY_FOR_FRESH_PAPER'
  | 'ACTIVE_PAPER';

@Injectable()
export class V8DedicatedPaperReadinessService {
  constructor(
    private readonly config: ConfigService,
    private readonly brokerService: BrokerService,
    private readonly executionService: ExecutionService,
    private readonly performance: ExternalSignalPerformanceService,
  ) {}
  async getStatus(requestingUserId: string) {
    const enabled = this.config.get<boolean>('v8DedicatedPaper.enabled', false) === true;
    const userId = this.config.get<string>('v8DedicatedPaper.userId', '').trim();
    const targetConnectionId = this.config
      .get<string>('v8DedicatedPaper.paperConnectionId', '')
      .trim();
    const v7ConnectionId = this.config
      .get<string>('vpsForexScanner.brokerConnectionId', '')
      .trim();
    const digest = this.config.get<string>('v8DedicatedPaper.artifactDigest', '').trim();
    const digestPresent = /^sha256:[0-9a-f]{64}$/i.test(digest);
    const configured = Boolean(userId && targetConnectionId && requestingUserId === userId);
    const isolatedTarget = Boolean(targetConnectionId && targetConnectionId !== v7ConnectionId);

    let targetPaper = false;
    if (configured) {
      try {
        const target = await this.brokerService.findConnectionById(targetConnectionId, userId);
        targetPaper = target.brokerId === 'paper-broker';
      } catch {
        targetPaper = false;
      }
    }

    const report = configured
      ? await this.performance.getProviderPerformance(userId, V7_PROVIDER)
      : null;
    const shadow = report?.v8ProspectiveShadow ?? null;
    const shadowReady = shadow?.screeningReadyForDedicatedPaper === true;

    let activeTargetSession = false;
    if (configured) {
      const session = await this.executionService.getActiveSession(userId);
      activeTargetSession = Boolean(
        session &&
          session.executionMode === ExecutionMode.PAPER_ONLY &&
          session.brokerConnectionId === targetConnectionId,
      );
    }

    let state: V8PaperState;
    if (!enabled) state = 'DISABLED';
    else if (!configured || !targetPaper) state = 'WAITING_FOR_CONFIGURATION';
    else if (!isolatedTarget) state = 'TARGET_NOT_ISOLATED';
    else if (!shadowReady) state = 'COLLECTING_PROSPECTIVE_SHADOW';
    else if (!digestPresent) state = 'WAITING_FOR_FROZEN_ARTIFACT';
    else if (!activeTargetSession) state = 'READY_FOR_FRESH_PAPER';
    else state = 'ACTIVE_PAPER';
    return {
      providerCode: V8_PROVIDER,
      modelVersion: V8_MODEL,
      enabled,
      configured: configured && targetPaper,
      isolatedTarget,
      targetPaperConnection: targetPaper,
      requiredFreshBaselineUsd: 10_000,
      v7EvidencePreserved: true,
      shadowEvidencePreservedButNotQualification: true,
      formalQualificationStartsAtZero: true,
      frozenArtifactRequired: true,
      frozenArtifactConfigured: digestPresent,
      activeTargetSession,
      state,
      prospectiveShadow: shadow
        ? {
            artifact: shadow.artifact,
            taggedSignals: shadow.taggedSignals,
            admittedSignals: shadow.admittedSignals,
            closedTrades: shadow.closedTrades,
            screeningReadyForDedicatedPaper: shadow.screeningReadyForDedicatedPaper,
          }
        : null,
      activationPolicy:
        'Dedicated v8 PAPER remains locked until prospective shadow screening is ready, a separate PAPER target is configured, and an immutable artifact digest is supplied. Activating it must not reset or overwrite v7 history.',
    };
  }
}
