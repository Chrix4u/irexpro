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
