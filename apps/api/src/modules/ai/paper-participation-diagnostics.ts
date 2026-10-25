export const PAPER_PARTICIPATION_DIAGNOSTICS_ARTIFACT =
  'paper-participation-diagnostics-v1' as const;

export type PaperParticipationBlockerCategory =
  | 'HARD_SAFETY'
  | 'EVIDENCE_QUALITY'
  | 'ROUTE_POLICY'
  | 'CAPACITY'
  | 'UNKNOWN';

export type PaperParticipationState =
  | 'EXECUTABLE_OPPORTUNITY'
  | 'RECENT_TRADE'
  | 'QUALIFIED_BUT_BLOCKED'
  | 'NO_QUALIFIED_OPPORTUNITY'
  | 'NO_RECENT_EVIDENCE';

export interface PaperParticipationM5Summary {
  latestScanAt: Date;
  evaluatedCandidates: number;
  executableWinners: number;
  bestInstrument: string | null;
  bestDirection: 'BUY' | 'SELL' | null;
  bestNetExpectedR: number | null;
  blockers: string[];
}

export interface PaperParticipationM1Decision {
  evaluatedAt: Date;
  route: string;
  executionAuthority: string;
  blockers: string[];
}

export interface PaperParticipationDiagnosticsInput {
  now: Date;
  lastTradeAt: Date | null;
  targetWindowMinutes: number;
  m5: PaperParticipationM5Summary | null;
  m5RecentBlockers: string[];
  m1Decisions: PaperParticipationM1Decision[];
}

function categoryForNormalizedBlocker(blocker: string): PaperParticipationBlockerCategory {
  if (
    blocker.startsWith('EVENT_RISK_') ||
    blocker === 'EXECUTION_SPREAD_UNAVAILABLE' ||
    blocker.startsWith('PAPER_POST_LOSS_') ||
    blocker.startsWith('PAPER_ENTRY_MARKET_') ||
    blocker.startsWith('ENTRY_MARKET_') ||
    blocker.includes('VOLATILITY')
  ) {
    return 'HARD_SAFETY';
  }
  if (
    blocker.includes('CURRENCY_CONCENTRATION') ||
    blocker.includes('PORTFOLIO') ||
    blocker.includes('ALLOCATION') ||
    blocker.includes('MARGIN') ||
    blocker.includes('EXPOSURE')
  ) {
    return 'CAPACITY';
  }
  if (
    blocker.startsWith('M1_PHASE_') ||
    blocker === 'M1_ROUTE_NOT_ELIGIBLE' ||
    blocker === 'M1_HIGHER_TIMEFRAME_CONFLICT' ||
    blocker.includes('ROUTE_OUTSIDE_') ||
    blocker.includes('NON_NORMAL_ROUTE_')
  ) {
    return 'ROUTE_POLICY';
  }
  if (
    blocker.includes('ENSEMBLE_NOT_') ||
    blocker.includes('NET_EXPECTED_R') ||
    blocker.startsWith('DRIFT_') ||
    blocker.startsWith('SLEEVE_') ||
    blocker.includes('RELIABILITY_') ||
    blocker.includes('CONFIDENCE') ||
    blocker.includes('CONSENSUS') ||
    blocker.includes('QUALITY') ||
    blocker.includes('MOMENTUM')
  ) {
    return 'EVIDENCE_QUALITY';
  }
  return 'UNKNOWN';
}

export function classifyPaperParticipationBlocker(
  blocker: string,
): PaperParticipationBlockerCategory {
  return categoryForNormalizedBlocker(
    String(blocker ?? '')
      .trim()
      .toUpperCase(),
  );
}

function ageMinutes(nowMs: number, value: Date | null): number | null {
  if (!(value instanceof Date)) return null;
  const valueMs = value.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(valueMs) || valueMs > nowMs) return null;
  return (nowMs - valueMs) / 60_000;
}

export function buildPaperParticipationDiagnostics(input: PaperParticipationDiagnosticsInput) {
  const nowMs = input.now.getTime();
  const targetWindowMinutes =
    Number.isFinite(input.targetWindowMinutes) && input.targetWindowMinutes > 0
      ? input.targetWindowMinutes
      : 30;
  const minutesSinceLastTrade = ageMinutes(nowMs, input.lastTradeAt);
  const m5AgeMinutes = input.m5 ? ageMinutes(nowMs, input.m5.latestScanAt) : null;
  const recentM5 =
    input.m5 && m5AgeMinutes !== null && m5AgeMinutes <= targetWindowMinutes ? input.m5 : null;
  const recentM1 = input.m1Decisions.filter((decision) => {
    const age = ageMinutes(nowMs, decision.evaluatedAt);
    return age !== null && age <= targetWindowMinutes;
  });

  const routeQualifiedDecisions = recentM1.filter(
    (decision) => decision.route !== 'ABSTAIN',
  ).length;
  const executableDecisions = recentM1.filter(
    (decision) => decision.executionAuthority !== 'NONE' && decision.route !== 'ABSTAIN',
  ).length;
  const blockerCounts = new Map<string, number>();
  for (const blocker of input.m5RecentBlockers) {
    const normalized = String(blocker ?? '')
      .trim()
      .toUpperCase();
    if (normalized) blockerCounts.set(normalized, (blockerCounts.get(normalized) ?? 0) + 1);
  }
  for (const decision of recentM1) {
    for (const blocker of decision.blockers) {
      const normalized = String(blocker ?? '')
        .trim()
        .toUpperCase();
      if (normalized) blockerCounts.set(normalized, (blockerCounts.get(normalized) ?? 0) + 1);
    }
  }
  const topBlockers = [...blockerCounts.entries()]
    .map(([blocker, count]) => ({
      blocker,
      category: classifyPaperParticipationBlocker(blocker),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker));

  const executableNow = (recentM5?.executableWinners ?? 0) > 0 || executableDecisions > 0;
  const recentTrade =
    minutesSinceLastTrade !== null && minutesSinceLastTrade <= targetWindowMinutes;
  const recentEvidence = recentM5 !== null || recentM1.length > 0;
  const qualifiedButBlocked =
    !executableNow &&
    (routeQualifiedDecisions > 0 ||
      (recentM5?.bestInstrument != null &&
        recentM5.bestNetExpectedR != null &&
        recentM5.bestNetExpectedR > 0));

  const state: PaperParticipationState = executableNow
    ? 'EXECUTABLE_OPPORTUNITY'
    : recentTrade
      ? 'RECENT_TRADE'
      : !recentEvidence
        ? 'NO_RECENT_EVIDENCE'
        : qualifiedButBlocked
          ? 'QUALIFIED_BUT_BLOCKED'
          : 'NO_QUALIFIED_OPPORTUNITY';

  return {
    artifact: PAPER_PARTICIPATION_DIAGNOSTICS_ARTIFACT,
    mode: 'DIAGNOSTIC_ONLY' as const,
    modifiesExecution: false as const,
    targetWindowMinutes,
    evaluatedAt: Number.isFinite(nowMs) ? input.now.toISOString() : null,
    state,
    minutesSinceLastTrade,
    m5: {
      latestScanAt: recentM5?.latestScanAt.toISOString() ?? null,
      evaluatedCandidates: recentM5?.evaluatedCandidates ?? 0,
      executableWinners: recentM5?.executableWinners ?? 0,
      bestInstrument: recentM5?.bestInstrument ?? null,
      bestDirection: recentM5?.bestDirection ?? null,
      bestNetExpectedR: recentM5?.bestNetExpectedR ?? null,
      blockers: recentM5?.blockers ?? [],
    },
    m1: {
      decisions: recentM1.length,
      routeQualifiedDecisions,
      executableDecisions,
    },
    topBlockers,
    methodology:
      'Read-only participation health from persisted M5 adaptive scans, recent M5/M1 blockers and signal-driven PAPER trade timestamps. The target window is diagnostic only and never forces a trade.',
  };
}
