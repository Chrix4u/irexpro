/**
 * Prospective owner Pepperstone USD DEMO signal diagnostics only.
 * No trained probability, trade veto, risk sizing, execution authority,
 * user-facing LIVE certification or promotion is derived from these tags.
 * Deliberately avoid learning a gate from 19 same-day retrospectively selected
 * wins/losses. Candidate features must be available before broker dispatch.
 */
export const OWNER_DEMO_PROSPECTIVE_ENTRY_QUALITY =
  'owner-demo-prospective-entry-quality-observation-v1' as const;

export interface ProspectiveEntryQualityInput {
  enabled: boolean;
  exactOwnerPepperstoneUsdDemoVerified: boolean;
  decisionAt: Date;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: string;
  strategyRoute: string | null;
  expertState: string | null;
  paperExpectancySamples: number | null;
  entryConfidence: number | null;
  m5Aligned: number | null;
  m30DirectionalEfficiency: number | null;
  h4Aligned: number | null;
  originalAdmissionBlockers: readonly string[];
  professionalFallbackExecutionEnabled: boolean;
}
export interface ProspectiveEntryQualityObservation {
  artifact: typeof OWNER_DEMO_PROSPECTIVE_ENTRY_QUALITY;
  status: 'ACTIVE_SHADOW' | 'DISABLED' | 'SCOPE_UNVERIFIED' | 'FEATURES_MISSING';
  researchOnly: true;
  modifiesAdmission: false;
  modifiesExecution: false;
  modifiesRiskOrLotSize: false;
  grantsLiveOrderAuthority: false;
  candidateWouldMatchOriginalHeldDoubleAbstain: boolean | null;
  alignmentGroup: 'M5_M30_BOTH_SUPPORT'|'M5_M30_DISAGREE'|'M5_M30_BOTH_ADVERSE'|'UNKNOWN';
  decisionTime: string | null;
  instrument: string;
  direction: string;
  strategyRoute: string | null;
  evidence: { confidence: number | null;m5Aligned: number | null;
    m30DirectionalEfficiency: number | null;h4Aligned: number | null;
    expertState: string | null;paperExpectancySamples: number | null } | null;
}
const valid=(n:number|null):number|null=>n!==null&&Number.isFinite(n)?n:null;
export function evaluateOwnerDemoProspectiveEntryQuality(
  input:ProspectiveEntryQualityInput,
):ProspectiveEntryQualityObservation {
  const baseline={artifact:OWNER_DEMO_PROSPECTIVE_ENTRY_QUALITY,researchOnly:true as const,
    modifiesAdmission:false as const,modifiesExecution:false as const,
    modifiesRiskOrLotSize:false as const,grantsLiveOrderAuthority:false as const,
    instrument:input.instrument,direction:input.direction,strategyRoute:input.strategyRoute,
  };
  const inactive=(status:'DISABLED'|'SCOPE_UNVERIFIED'|'FEATURES_MISSING')=>({
    ...baseline,status,candidateWouldMatchOriginalHeldDoubleAbstain:null,
    alignmentGroup:'UNKNOWN' as const,decisionTime:null,evidence:null,
  });
  if(!input.enabled)return inactive('DISABLED');
  if(!input.exactOwnerPepperstoneUsdDemoVerified)return inactive('SCOPE_UNVERIFIED');
  const m5=valid(input.m5Aligned),m30=valid(input.m30DirectionalEfficiency);
  if(!Number.isFinite(input.decisionAt.getTime()) || m5===null || m30===null)
    return inactive('FEATURES_MISSING');
  const blocked=input.route==='ABSTAIN'&&input.expertState==='ABSTAIN'&&
    input.paperExpectancySamples===0&&!input.professionalFallbackExecutionEnabled&&
    input.originalAdmissionBlockers.includes('DRIFT_OUT_OF_DISTRIBUTION')&&
    input.originalAdmissionBlockers.includes('ENSEMBLE_NOT_PAPER_ADMITTED');
  return {...baseline,status:'ACTIVE_SHADOW' as const,
    candidateWouldMatchOriginalHeldDoubleAbstain:blocked,
    alignmentGroup:m5>=0&&m30>=0?'M5_M30_BOTH_SUPPORT' as const:
      m5<0&&m30<0?'M5_M30_BOTH_ADVERSE' as const:
        'M5_M30_DISAGREE' as const,
    decisionTime:input.decisionAt.toISOString(),
    evidence:{confidence:valid(input.entryConfidence),m5Aligned:m5,
      m30DirectionalEfficiency:m30,h4Aligned:valid(input.h4Aligned),
      expertState:input.expertState,paperExpectancySamples:input.paperExpectancySamples},
  };
}
