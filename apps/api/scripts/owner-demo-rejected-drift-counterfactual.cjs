/**
 * Additional, SEPARATE view of the existing rejected-drift counterfactual
 * worker. Never compare its labels as interchangeable observations with
 * ordinary M1 shadow outcomes: the two workers have different selection rules.
 *
 * Causal future-quote evaluator is shared, but that does not fix selection
 * bias, fill uncertainty, or non-drift admission blockers.
 */
'use strict';

const VERSION = 'm1-drift-counterfactual-15m-v1';
const VALID_OUTCOME = new Set(['TP', 'SL', 'MTM']);
const REJECTED_STATES = new Set(['OUT_OF_DISTRIBUTION', 'STRESSED']);
const toTime = value => {
  if (value == null || value === '') return null;
  const valueMs = new Date(value).getTime();
  return Number.isFinite(valueMs) ? valueMs : null;
};
const num = value => (
  value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value)
);
const rounded = n => Number(n.toFixed(4));

function driftCounterfactualLabel(row, asOfMs) {
  const o = row.drift_outcome;
  if (!o || !REJECTED_STATES.has(row.drift) ||
      o.artifact !== VERSION ||
      o.modifiesExecution !== false ||
      o.source !== 'COMPLETED_M1_OHLC' ||
      o.horizonBars !== 15 ||
      o.selectionPolicy !== 'FIXED_UTC_16M_EPISODE_RESEARCH' ||
      !VALID_OUTCOME.has(o.outcome) ||
      o.driftStateAtDecision !== row.drift ||
      !['MULTIMODEL', 'GENERIC'].includes(o.driftEvidenceSource) ||
      !Array.isArray(o.nonDriftBlockersAtDecision)) return null;
  const evaluatedAt = toTime(row.bar_time);
  const observedAt = toTime(o.observedAt);
  const entryAt = toTime(o.entryBarOpenTime);
  const cost = num(o.estimatedExecutionCostR);
  const net = num(o.netRMultiple);
  const gross = num(o.grossRMultiple);
  if (evaluatedAt == null || observedAt == null || entryAt == null ||
      observedAt > asOfMs || entryAt < evaluatedAt + 60_000 ||
      observedAt <= entryAt || cost == null || cost < 0 ||
      net == null || gross == null || Math.abs(net) > 1000 ||
      Math.abs((gross - cost) - net) > 0.0001) return null;
  const costSource = o.driftEvidenceSource === 'MULTIMODEL'
    ? row.multimodel_cost_source
    : row.generic_cost_source;
  // Cost-source string comes from the persisted decision-time governance,
  // not an inferred execution or a hypothetical broker fill.
  return {
    netR: net,
    outcome: o.outcome,
    costSource: costSource || 'UNKNOWN',
    nonDriftBlockers: o.nonDriftBlockersAtDecision
      .filter(x => typeof x === 'string'),
    driftWasOnlySubstantiveBlocker: o.driftWasOnlySubstantiveBlocker === true,
    observedAt: new Date(observedAt).toISOString(),
  };
}

function summarizeRejectedDriftCounterfactuals(rows, asOf) {
  const asOfMs = toTime(asOf);
  if (asOfMs == null) throw Error('A valid as-of timestamp is required');
  // Only fixed-bucket rejected signals have drift-counterfactual labels.
  // Do NOT rank them against NORMAL shadow labels or call them fills.
  const rejected = rows.filter(row => REJECTED_STATES.has(row.drift));
  const withArtifact = rejected.filter(row => row.drift_outcome != null);
  const labeled = withArtifact.flatMap(row => {
    const label = driftCounterfactualLabel(row, asOfMs);
    return label ? [{ row, label }] : [];
  });
  const byGroup = new Map();
  for (const event of labeled) {
    const key = [
      event.row.instrument,
      event.row.strategy_route || 'UNKNOWN',
      event.row.drift,
      event.label.driftWasOnlySubstantiveBlocker
        ? 'DRIFT_ONLY'
        : 'OTHER_BLOCKERS_PRESENT',
    ].join(' / ');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(event.label);
  }
  const groups = [...byGroup].map(([key, group]) => {
    const net = group.map(x => x.netR);
    const sum = net.reduce((a,b)=>a+b,0);
    return {
      key,
      labeledFixedBucketDecisions:group.length,
      brokerObservedP90CostLabels:group.filter(x=>x.costSource==='BROKER_OBSERVED_P90').length,
      otherCostLabels:group.filter(x=>x.costSource!=='BROKER_OBSERVED_P90').length,
      positiveEstimatedNetR:group.filter(x=>x.netR>0).length,
      negativeEstimatedNetR:group.filter(x=>x.netR<0).length,
      sumEstimatedNetR:rounded(sum),
      averageEstimatedNetR:rounded(sum/group.length),
    };
  }).sort((a,b)=>b.labeledFixedBucketDecisions-a.labeledFixedBucketDecisions);
  return {
    artifact:'owner-demo-rejected-drift-counterfactual-descriptive-v1',
    sourceArtifact:VERSION,
    selection:'FIXED_UTC_16M_EPISODE_RESEARCH_OTHER_BLOCKERS_MAY_REMAIN',
    comparisonToNormalShadow:'NOT_COMPARABLE_SELECTION_POLICY',
    accountScope:'OWNER_PEPPERSTONE_USD_DEMO_ONLY',
    modifiesExecution:false,
    grantsTradeAuthority:false,
    modelTrainingStatus:'NOT_TRAINED',
    rejectedDirectionalDecisions:rejected.length,
    withCounterfactualArtifact:withArtifact.length,
    validCounterfactualQuoteLabels:labeled.length,
    unverifiedCounterfactualLabels:withArtifact.length-labeled.length,
    unselectedOrUnsettledDecisions:rejected.length-withArtifact.length,
    driftOnlyQuoteLabels:labeled.filter(x=>x.label.driftWasOnlySubstantiveBlocker).length,
    quoteLabelsWithOtherBlockers:labeled.filter(x=>!x.label.driftWasOnlySubstantiveBlocker).length,
    groups:groups.slice(0,60),
    groupListTruncated:groups.length>60,
    limitations:[
      'Rejected-drift worker samples one earliest candidate per instrument per fixed UTC 16-minute bin; BUY and SELL may be underrepresented unequally.',
      'Ordinary 15-minute shadow worker selects different eligibility classes; direct winning percentages are not comparable.',
      'Other Plan B, expert, safety and profitability vetoes remain even if drift were not a blocker.',
      'Quotes and inferred cost are not broker fills; model thresholds cannot be promoted by this report.',
    ],
  };
}

module.exports = { driftCounterfactualLabel, summarizeRejectedDriftCounterfactuals };
