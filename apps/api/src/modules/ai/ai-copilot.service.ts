import { Injectable } from '@nestjs/common';
import { MarketIntelligenceResponseDto } from '../market-data/dto/market-intelligence-response.dto';
import { MarketIntelligenceService } from '../market-data/market-intelligence.service';
import { RiskIntelligenceResponseDto } from '../risk/dto/risk-intelligence-response.dto';
import { RiskIntelligenceService } from '../risk/risk-intelligence.service';
import {
  StrategyLabCandidateDto,
  StrategyLabResponseDto,
  StrategyLabScenarioDto,
} from '../strategy/dto/strategy-lab-response.dto';
import { StrategyLabService } from '../strategy/strategy-lab.service';
import { AiDecisionExplorerService } from './ai-decision-explorer.service';
import { AiCopilotQueryDto } from './dto/ai-copilot-query.dto';
import { AiDecisionSummaryDto } from './dto/ai-decision-explorer-response.dto';
import {
  AiCopilotEvidenceDto,
  AiCopilotPosture,
  AiCopilotResponseDto,
  AiCopilotStrategyResearchContextDto,
} from './dto/ai-copilot-response.dto';

@Injectable()
export class AiCopilotService {
  constructor(
    private readonly marketIntelligence: MarketIntelligenceService,
    private readonly riskIntelligence: RiskIntelligenceService,
    private readonly decisionExplorer: AiDecisionExplorerService,
    private readonly strategyLab: StrategyLabService,
  ) {}

  async getContext(userId: string, query: AiCopilotQueryDto): Promise<AiCopilotResponseDto> {
    const instrument = query.instrument.toUpperCase();
    const timeframe = query.timeframe.toUpperCase();

    const [market, risk, decisions, strategy] = await Promise.all([
      this.readSource(() =>
        this.marketIntelligence.getSnapshot(userId, {
          instrument,
          timeframe: query.timeframe,
          limit: 60,
        }),
      ),
      this.readSource(() => this.riskIntelligence.getIntelligence(userId)),
      this.readSource(() => this.decisionExplorer.getRecentDecisions(userId, 25)),
      this.readSource(() => this.strategyLab.getSnapshot()),
    ]);

    const decision = this.findDecision(decisions?.decisions ?? [], instrument, timeframe);
    const strategyResearch = this.findStrategyResearch(strategy, decision, timeframe);
    const posture = this.getPosture(market, risk);
    const evidence = this.buildEvidence(market, risk, decision, strategy, strategyResearch);

    return {
      generatedAt: new Date().toISOString(),
      instrument,
      timeframe,
      status: market && risk && decisions && strategy ? 'READY' : 'PARTIAL',
      posture,
      ...this.describePosture(posture, risk),
      market: market
        ? {
            freshness: market.status,
            bid: market.quote.bid,
            ask: market.quote.ask,
            spread: market.quote.spread,
            quoteAt: market.quote.timestamp,
            retrievedAt: market.retrievedAt,
          }
        : null,
      risk: risk
        ? {
            killSwitchActive: risk.engine.killSwitchActive,
            brokerConnected: risk.engine.brokerConnected,
            riskAcknowledgementAccepted: risk.policy.riskAcknowledgementAccepted,
            openPositionSlotsRemaining: risk.execution.openPositionSlotsRemaining,
            todayTrades: risk.execution.todayTrades,
            dailyTradeCountPolicy: risk.execution.dailyTradeCountPolicy,
            stalePortfolioSnapshots: risk.portfolio.staleSnapshots,
            unavailablePortfolioSnapshots: risk.portfolio.unavailableSnapshots,
            recentViolationCount: risk.recentViolations.length,
          }
        : null,
      decision: decision
        ? {
            signalId: decision.signalId,
            outcome: decision.outcome,
            direction: decision.evidence.direction,
            confidenceScore: decision.evidence.confidenceScore,
            strategyCode: decision.evidence.strategyCode,
            modelVersion: decision.evidence.modelVersion,
            marketRegime: decision.evidence.marketRegime,
            receivedAt: decision.receivedAt,
            riskDecision: decision.risk.decision,
            executionStatus: decision.execution?.status ?? null,
          }
        : null,
      strategyResearch,
      evidence,
      nextChecks: this.buildNextChecks(market, risk, decision, strategyResearch),
      policy: {
        explanationOnly: true,
        noTradeInstruction: true,
        hiddenReasoningExposed: false,
        strategyResearchAdvisoryOnly: true,
      },
    };
  }

  private async readSource<T>(read: () => Promise<T> | T): Promise<T | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  private findDecision(
    decisions: AiDecisionSummaryDto[],
    instrument: string,
    timeframe: string,
  ): AiDecisionSummaryDto | null {
    return (
      decisions.find(
        (decision) =>
          decision.evidence.instrument?.toUpperCase() === instrument &&
          decision.evidence.timeframe?.toUpperCase() === timeframe,
      ) ?? null
    );
  }

  private findStrategyResearch(
    strategy: StrategyLabResponseDto | null,
    decision: AiDecisionSummaryDto | null,
    timeframe: string,
  ): AiCopilotStrategyResearchContextDto | null {
    const strategyCode = decision?.evidence.strategyCode;
    if (!strategy || !strategyCode) return null;

    const matches = strategy.scenarios
      .map((scenario) => ({
        scenario,
        candidate: scenario.candidates.find(
          (candidate) =>
            candidate.strategyCode === strategyCode &&
            candidate.timeframe.toUpperCase() === timeframe,
        ),
      }))
      .filter(
        (item): item is { scenario: StrategyLabScenarioDto; candidate: StrategyLabCandidateDto } =>
          item.candidate !== undefined,
      );

    if (matches.length === 0) return null;

    const regime = decision.evidence.marketRegime?.toUpperCase();
    const match = matches.find((item) => item.scenario.marketRegime === regime) ?? matches[0];

    return {
      datasetId: strategy.dataset.id,
      datasetVersion: strategy.dataset.version,
      asOf: strategy.dataset.asOf,
      scenarioId: match.scenario.id,
      marketRegime: match.scenario.marketRegime,
      strategyCode: match.candidate.strategyCode,
      eligible: match.candidate.eligible,
      score: match.candidate.score,
      advisoryOnly: true,
    };
  }

  private getPosture(
    market: MarketIntelligenceResponseDto | null,
    risk: RiskIntelligenceResponseDto | null,
  ): AiCopilotPosture {
    if (!risk) return 'BLOCKED';

    if (
      risk.engine.killSwitchActive ||
      !risk.engine.brokerConnected ||
      !risk.policy.riskAcknowledgementAccepted ||
      risk.execution.openPositionSlotsRemaining <= 0
    ) {
      return 'BLOCKED';
    }

    if (
      !market ||
      market.status === 'STALE' ||
      risk.portfolio.staleSnapshots > 0 ||
      risk.portfolio.unavailableSnapshots > 0
    ) {
      return 'CAUTION';
    }

    return 'NORMAL';
  }

  private describePosture(
    posture: AiCopilotPosture,
    risk: RiskIntelligenceResponseDto | null,
  ): Pick<AiCopilotResponseDto, 'headline' | 'explanation'> {
    if (posture === 'BLOCKED') {
      return {
        headline: 'Risk authority does not support a ready posture',
        explanation: risk
          ? 'One or more authoritative risk prerequisites are not satisfied. The Copilot reports that evidence without creating or bypassing an execution decision.'
          : 'Risk Intelligence is unavailable, so the Copilot fails closed and cannot characterize execution readiness.',
      };
    }

    if (posture === 'CAUTION') {
      return {
        headline: 'Authoritative context has freshness warnings',
        explanation:
          'One or more read models are stale or incomplete. The Copilot preserves the warning and does not fill missing market or portfolio evidence with estimates.',
      };
    }

    return {
      headline: 'Authoritative context is aligned',
      explanation:
        'The current read models are available and fresh enough for explanation. Any future execution still requires the live Risk Engine and Execution Engine gates.',
    };
  }

  private buildEvidence(
    market: MarketIntelligenceResponseDto | null,
    risk: RiskIntelligenceResponseDto | null,
    decision: AiDecisionSummaryDto | null,
    strategy: StrategyLabResponseDto | null,
    strategyResearch: AiCopilotStrategyResearchContextDto | null,
  ): AiCopilotEvidenceDto[] {
    const evidence: AiCopilotEvidenceDto[] = [];

    evidence.push(
      market
        ? {
            source: 'MARKET',
            state: market.status,
            summary: `Provider-backed ${market.instrument}/${market.timeframe} market evidence is ${market.status.toLowerCase()}.`,
          }
        : {
            source: 'MARKET',
            state: 'UNAVAILABLE',
            summary: 'Provider-backed market evidence is unavailable.',
          },
    );

    if (!risk) {
      evidence.push({
        source: 'RISK',
        state: 'UNAVAILABLE',
        summary: 'Authoritative Risk Intelligence is unavailable.',
      });
    } else {
      const blocked = this.getPosture(market, risk) === 'BLOCKED';
      const stale = risk.portfolio.staleSnapshots > 0 || risk.portfolio.unavailableSnapshots > 0;
      evidence.push({
        source: 'RISK',
        state: blocked ? 'BLOCKED' : stale ? 'STALE' : 'AVAILABLE',
        summary: blocked
          ? 'A risk prerequisite currently prevents a ready posture.'
          : stale
            ? 'Risk policy is available, but one or more portfolio snapshots need attention.'
            : 'Risk policy, capacity, and portfolio freshness are available.',
      });
    }

    evidence.push(
      decision
        ? {
            source: 'AI_DECISION',
            state: 'AVAILABLE',
            summary: `Latest matching persisted AI decision is ${decision.outcome}.`,
          }
        : {
            source: 'AI_DECISION',
            state: 'NONE',
            summary: 'No persisted AI decision matches the selected instrument and timeframe.',
          },
    );

    evidence.push(
      !strategy
        ? {
            source: 'STRATEGY_RESEARCH',
            state: 'UNAVAILABLE',
            summary: 'Deterministic Strategy Lab research is unavailable.',
          }
        : strategyResearch
          ? {
              source: 'STRATEGY_RESEARCH',
              state: 'AVAILABLE',
              summary:
                'The persisted AI strategy has a matching deterministic historical research fixture. The fixture remains advisory only.',
            }
          : {
              source: 'STRATEGY_RESEARCH',
              state: 'NONE',
              summary:
                'Strategy Lab is available, but no matching persisted AI strategy evidence maps to the selected context.',
            },
    );

    return evidence;
  }

  private buildNextChecks(
    market: MarketIntelligenceResponseDto | null,
    risk: RiskIntelligenceResponseDto | null,
    decision: AiDecisionSummaryDto | null,
    strategyResearch: AiCopilotStrategyResearchContextDto | null,
  ): string[] {
    const checks: string[] = [];

    if (!risk || this.getPosture(market, risk) === 'BLOCKED') {
      checks.push(
        'Review the authoritative Risk Engine status before interpreting execution readiness.',
      );
    }
    if (!market || market.status === 'STALE') {
      checks.push(
        'Wait for fresh provider-backed market evidence before relying on market context.',
      );
    }
    if (!decision) {
      checks.push('Inspect Decision Explorer after a matching AI signal is persisted.');
    }
    if (decision && !strategyResearch) {
      checks.push(
        'Treat Strategy Lab as separate historical research when no matching fixture exists.',
      );
    }

    if (checks.length === 0) {
      checks.push(
        'Continue to use the live Risk Engine and Execution Engine as the only execution authority.',
      );
    }

    return checks;
  }
}
