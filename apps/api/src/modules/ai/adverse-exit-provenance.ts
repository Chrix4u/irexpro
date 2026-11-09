/**
 * Research-only attribution of historical DEMO AI close requests.
 *
 * A provider reconciliation close may omit the request producer's reason.
 * Join only the same user and Trade's close-request evidence within a bounded
 * window. Close request evidence can support an APP CORRELATION, never a
 * certified provider-side reason or a new trading signal.
 */
export type AdverseExitReason =
  | 'ADVERSE_THESIS_FAILED'
  | 'EMERGENCY_ADVERSE_CUT'
  | 'UNVERIFIED_IN_TRADE_AUDIT';

export type AdverseExitEvidenceSource =
  | 'TRADE_CLOSED_DIRECT'
  | 'TRADE_CLOSE_REQUESTED_CORRELATED'
  | 'TRADE_SUBMITTED_CORRELATED'
  | 'UNVERIFIED';

export interface AdverseExitProvenance {
  reason: AdverseExitReason;
  source: AdverseExitEvidenceSource;
  auditedAtClose: boolean;
  correlatedAppRequest: boolean;
  requestEvidenceCount: number;
  brokerReasonCertified: false;
}

interface CloseRequestAuditRecord {
  action?: unknown;
  closeReason?: unknown;
  aiCloseTrigger?: {
    source?: unknown;
    reasonCode?: unknown;
  } | null;
}

const allowed = (
  value: unknown,
): value is Exclude<AdverseExitReason, 'UNVERIFIED_IN_TRADE_AUDIT'> =>
  value === 'ADVERSE_THESIS_FAILED' || value === 'EMERGENCY_ADVERSE_CUT';

function decodeArray(data: unknown): CloseRequestAuditRecord[] | null {
  if (data === null || data === undefined) return [];
  let value: unknown = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  if (value.length > 3) return null;
  if (value.some((record) => !record || typeof record !== 'object' || Array.isArray(record)))
    return null;
  return value as CloseRequestAuditRecord[];
}

export function resolveAdverseExitProvenance(input: {
  directCloseReason: unknown;
  requestEvidence: unknown;
}): AdverseExitProvenance {
  const records = decodeArray(input.requestEvidence);
  const requestEvidenceCount = records?.length ?? 0;
  const unknown = (): AdverseExitProvenance => ({
    reason: 'UNVERIFIED_IN_TRADE_AUDIT',
    source: 'UNVERIFIED',
    auditedAtClose: false,
    correlatedAppRequest: false,
    requestEvidenceCount,
    brokerReasonCertified: false,
  });

  // Missing or conflicting audit rows are not evidence of a particular close.
  if (records === null) return unknown();
  const reasonSet = new Set<Exclude<AdverseExitReason, 'UNVERIFIED_IN_TRADE_AUDIT'>>();
  for (const item of records) {
    if (
      (item.action !== 'TRADE_CLOSE_REQUESTED' && item.action !== 'TRADE_SUBMITTED') ||
      item.closeReason !== 'AI_CLOSE_SIGNAL' ||
      item.aiCloseTrigger?.source !== 'BROKER_ADVERSE_PROTECTION' ||
      !allowed(item.aiCloseTrigger.reasonCode)
    )
      return unknown();
    reasonSet.add(item.aiCloseTrigger.reasonCode);
  }
  if (reasonSet.size > 1) return unknown();

  if (allowed(input.directCloseReason)) {
    if (reasonSet.size === 1 && !reasonSet.has(input.directCloseReason)) return unknown();
    return {
      reason: input.directCloseReason,
      source: 'TRADE_CLOSED_DIRECT',
      auditedAtClose: true,
      correlatedAppRequest: false,
      requestEvidenceCount,
      brokerReasonCertified: false,
    };
  }
  if (reasonSet.size !== 1) return unknown();
  const reason = [...reasonSet][0];
  return {
    reason,
    source: records.some((x) => x.action === 'TRADE_CLOSE_REQUESTED')
      ? 'TRADE_CLOSE_REQUESTED_CORRELATED'
      : 'TRADE_SUBMITTED_CORRELATED',
    auditedAtClose: false,
    correlatedAppRequest: true,
    requestEvidenceCount,
    brokerReasonCertified: false,
  };
}
