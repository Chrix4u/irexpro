import type { PlanBV4BrokerScore } from '../ai-engine-client/ai-engine-client.service';

const EXPERT_NAMES = [
  'event_barrier_two_stage',
  'event_barrier_pair_experts',
  'event_barrier_pair_regime_experts',
] as const;

type ExpertName = (typeof EXPERT_NAMES)[number];

interface ExpertObservation {
  name: ExpertName;
  predictedLong: boolean;
  directionProbabilityLong: number;
  directionConfidence: number;
  opportunityProbability: number;
}

export interface ExpertResearchEvidence {
  schemaVersion: 1;
  artifact: string;
  experts: ExpertObservation[];
  modifiesExecution: false;
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Capture bounded, validated observations. Missing evidence never changes admission. */
export function captureExpertResearchEvidence(
  score: PlanBV4BrokerScore,
): ExpertResearchEvidence | undefined {
  if (
    !Array.isArray(score.experts) ||
    score.experts.length !== EXPERT_NAMES.length ||
    score.artifact !== 'plan-b-v4-oof-three-expert-consensus-challenger'
  ) {
    return undefined;
  }

  const experts: ExpertObservation[] = [];
  for (const name of EXPERT_NAMES) {
    const matches = score.experts.filter(
      (value: unknown) =>
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).name === name,
    );
    if (matches.length !== 1) return undefined;
    const raw = matches[0] as Record<string, unknown>;
    if (
      typeof raw.predicted_long !== 'boolean' ||
      !probability(raw.direction_probability_long) ||
      !probability(raw.direction_confidence) ||
      !probability(raw.opportunity_probability)
    ) {
      return undefined;
    }
    experts.push({
      name,
      predictedLong: raw.predicted_long,
      directionProbabilityLong: raw.direction_probability_long,
      directionConfidence: raw.direction_confidence,
      opportunityProbability: raw.opportunity_probability,
    });
  }

  if (experts.filter((expert) => expert.predictedLong).length !== score.long_votes) {
    return undefined;
  }
  if (experts.filter((expert) => !expert.predictedLong).length !== score.short_votes) {
    return undefined;
  }
  return { schemaVersion: 1, artifact: score.artifact, experts, modifiesExecution: false };
}
