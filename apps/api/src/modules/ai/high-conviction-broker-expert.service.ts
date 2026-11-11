import { Injectable, Logger } from '@nestjs/common';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import {
  classifyHighConvictionOverlay,
  type HighConvictionOverlay,
} from './high-conviction-overlay';

export interface HighConvictionBrokerExpertInput {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  candidateDirection: 'BUY' | 'SELL';
  candidateCloseTime: Date;
}

function unavailable(reason: string): HighConvictionOverlay {
  return {
    state: 'UNAVAILABLE',
    reason,
    decisionTime: null,
    freshnessSeconds: null,
    allBrokerNative: false,
    direction: null,
    admitted: null,
    ensembleConfidence: null,
    meanOpportunityProbability: null,
    longVotes: null,
    shortVotes: null,
    regime: null,
    modifiesExecution: false,
  };
}

@Injectable()
export class HighConvictionBrokerExpertService {
  private readonly logger = new Logger(HighConvictionBrokerExpertService.name);

  constructor(private readonly aiEngineClient: AiEngineClient) {}

  /**
   * Take one broker-native model snapshot for both opposing M1 candidates
   * within the SAME instrument/decision slot. The raw request is direction-
   * independent; each candidate still gets its own fail-closed classification.
   *
   * This method has no persistent cache. The caller owns the exact slot
   * lifetime and MUST NOT share results across accounts, pairs or minutes.
   */
  async evaluatePair(
    input: Omit<HighConvictionBrokerExpertInput, 'candidateDirection'>,
  ): Promise<Readonly<Record<'BUY' | 'SELL', HighConvictionOverlay>>> {
    try {
      const response = await this.aiEngineClient.scorePlanBV4ChallengerBroker({
        userId: input.userId,
        brokerConnectionId: input.brokerConnectionId,
        instrument: input.instrument.trim().toUpperCase(),
      });
      return {
        BUY: classifyHighConvictionOverlay(response, 'BUY', input.candidateCloseTime),
        SELL: classifyHighConvictionOverlay(response, 'SELL', input.candidateCloseTime),
      };
    } catch (error) {
      this.logger.warn(
        `Plan-B trained broker expert unavailable instrument=${input.instrument.trim().toUpperCase()}: ${(error as Error).message}`,
      );
      // One failed broker score means NEITHER direction may gain authority.
      return {
        BUY: unavailable('TRAINED_EXPERT_REQUEST_FAILED'),
        SELL: unavailable('TRAINED_EXPERT_REQUEST_FAILED'),
      };
    }
  }

  async evaluate(input: HighConvictionBrokerExpertInput): Promise<HighConvictionOverlay> {
    try {
      const response = await this.aiEngineClient.scorePlanBV4ChallengerBroker({
        userId: input.userId,
        brokerConnectionId: input.brokerConnectionId,
        instrument: input.instrument.trim().toUpperCase(),
      });
      return classifyHighConvictionOverlay(
        response,
        input.candidateDirection,
        input.candidateCloseTime,
      );
    } catch (error) {
      this.logger.warn(
        `Plan-B trained broker expert unavailable instrument=${input.instrument.trim().toUpperCase()}: ${(error as Error).message}`,
      );
      return unavailable('TRAINED_EXPERT_REQUEST_FAILED');
    }
  }
}
