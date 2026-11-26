'use strict';

// Standalone descriptive research; no broker, database, or execution dependencies.
function evaluateExpertEvidence(input) {
  const names = [
    'event_barrier_two_stage',
    'event_barrier_pair_experts',
    'event_barrier_pair_regime_experts',
  ];
  if (!input || !Array.isArray(input.observations) || input.observations.length > 100000 ||
      !Number.isSafeInteger(input.horizonSeconds) || input.horizonSeconds <= 0) {
    throw new Error('Expected bounded observations and a fixed positive horizonSeconds');
  }
  const seen = new Set();
  const scores = names.map(name => ({name, correct:0, up:0, down:0, correctUp:0, correctDown:0, squaredError:0, bins:Array.from({length:5},(_,i)=>({lower:i/5, upper:(i+1)/5,count:0,probabilitySum:0,up:0}))}));
  const pairs = [[0,1],[0,2],[1,2]].map(([i,j])=>({i,j,agree:0,bothWrong:0,firstWrong:0,secondWrong:0}));
  const probability = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  let resolved = 0, unresolved = 0;
  for (const row of input.observations) {
    if (!row || typeof row.sampleId !== 'string' || !row.sampleId || seen.has(row.sampleId)) throw new Error('Missing or duplicate sample identifier');
    seen.add(row.sampleId);
    if (typeof row.predictionAt !== 'string' || !/Z$/.test(row.predictionAt) ||
        !Number.isFinite(Date.parse(row.predictionAt))) throw new Error('Invalid prediction timestamp');
    const evidence = row.evidence;
    if (!evidence || evidence.schemaVersion !== 1 || evidence.modifiesExecution !== false ||
        evidence.artifact !== 'plan-b-v4-oof-three-expert-consensus-challenger' ||
        !Array.isArray(evidence.experts) || evidence.experts.length !== names.length) throw new Error('Invalid research evidence');
    const experts = names.map(name => {
      const found = evidence.experts.filter(e => e && e.name === name);
      if (found.length !== 1 || typeof found[0].predictedLong !== 'boolean' ||
          !probability(found[0].directionProbabilityLong) ||
          !probability(found[0].directionConfidence) ||
          !probability(found[0].opportunityProbability)) throw new Error('Invalid individual expert observation');
      return found[0];
    });
    if (row.outcome === null) { unresolved++; continue; }
    if (!['UP','DOWN'].includes(row.outcome) || typeof row.labelAt !== 'string' ||
        !/Z$/.test(row.labelAt) ||
        Date.parse(row.labelAt) - Date.parse(row.predictionAt) !== input.horizonSeconds * 1000) throw new Error('Invalid independently supplied fixed-horizon label');
    resolved++;
    const up = row.outcome === 'UP';
    const wrong = experts.map(e => e.predictedLong !== up);
    experts.forEach((e,i)=>{
      const s = scores[i];
      if (up) {s.up++; if(!wrong[i]) s.correctUp++;}
      else {s.down++; if(!wrong[i]) s.correctDown++;}
      if (!wrong[i]) s.correct++;
      s.squaredError += (e.directionProbabilityLong - Number(up)) ** 2;
      const bin = s.bins[Math.min(4,Math.floor(e.directionProbabilityLong * 5))];
      bin.count++; bin.probabilitySum+=e.directionProbabilityLong; bin.up+=Number(up);
    });
    for (const p of pairs) {
      p.agree += Number(experts[p.i].predictedLong === experts[p.j].predictedLong);
      p.bothWrong += Number(wrong[p.i] && wrong[p.j]);
      p.firstWrong += Number(wrong[p.i]); p.secondWrong += Number(wrong[p.j]);
    }
  }
  const ratio=(a,b)=>b?a/b:null;
  return {schemaVersion:1, purpose:'DESCRIPTIVE_OFFLINE_ONLY', modifiesExecution:false, horizonSeconds:input.horizonSeconds, resolved, unresolved,
    experts:scores.map(s=>({name:s.name, observations:resolved, correct:s.correct, up:s.up, down:s.down, accuracy:ratio(s.correct,resolved), balancedAccuracy:s.up&&s.down?(s.correctUp/s.up+s.correctDown/s.down)/2:null,brierScore:ratio(s.squaredError,resolved), calibration:s.bins.map(b=>({lower:b.lower,upper:b.upper,count:b.count,meanProbability:ratio(b.probabilitySum,b.count),observedUpRate:ratio(b.up,b.count)}))})),
    pairwise:pairs.map(p=>{
      const den=Math.sqrt(p.firstWrong*(resolved-p.firstWrong)*p.secondWrong*(resolved-p.secondWrong));
      return {experts:[names[p.i],names[p.j]],agreementRate:ratio(p.agree,resolved),bothWrong:p.bothWrong, errorCorrelation:den?(resolved*p.bothWrong-p.firstWrong*p.secondWrong)/den:null};
    }), limitations:['Labels must be independently generated and fixed before evaluation; this function checks format and timestamps, not label provenance.','Observations can overlap and are not necessarily statistically independent.','These are descriptive prediction statistics, not trade returns or evidence of execution readiness.']};
}

module.exports = { evaluateExpertEvidence };
