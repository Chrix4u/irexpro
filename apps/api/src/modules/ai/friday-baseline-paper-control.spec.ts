import {
  isFridayBaselinePaperExecutionAllowed,
  selectPaperExecutionRoute,
} from './paper-research-throughput';

describe('Friday baseline PAPER control', () => {
  it('keeps NORMAL_PAPER executable', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: true,
      rejectedEdgeCanaryEligible: true,
      rejectedEdgeCanaryExecutionEnabled: true,
      paperResearchThroughputEligible: true,
      extensionExhaustionResearchEligible: true,
      pairedReversalResearchEligible: true,
    });

    expect(route).toBe('NORMAL_PAPER');
    expect(isFridayBaselinePaperExecutionAllowed(route)).toBe(true);
  });

  it('keeps rejected-edge canary classified for evidence but quarantines execution', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: true,
      rejectedEdgeCanaryExecutionEnabled: true,
      paperResearchThroughputEligible: false,
      extensionExhaustionResearchEligible: false,
      pairedReversalResearchEligible: false,
    });

    expect(route).toBe('REJECTED_EDGE_CANARY');
    expect(isFridayBaselinePaperExecutionAllowed(route)).toBe(false);
  });

  it('keeps research throughput classified for evidence but quarantines execution', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: false,
      paperResearchThroughputEligible: true,
      extensionExhaustionResearchEligible: false,
      pairedReversalResearchEligible: false,
    });

    expect(route).toBe('PAPER_RESEARCH_THROUGHPUT');
    expect(isFridayBaselinePaperExecutionAllowed(route)).toBe(false);
  });

  it('keeps extension-exhaustion classified for evidence but quarantines execution', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: false,
      paperResearchThroughputEligible: false,
      extensionExhaustionResearchEligible: true,
      pairedReversalResearchEligible: false,
    });

    expect(route).toBe('PAPER_EXTENSION_EXHAUSTION_RESEARCH');
    expect(isFridayBaselinePaperExecutionAllowed(route)).toBe(false);
  });

  it('keeps paired-reversal classified for evidence but quarantines execution', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: false,
      paperResearchThroughputEligible: false,
      extensionExhaustionResearchEligible: false,
      pairedReversalResearchEligible: true,
    });

    expect(route).toBe('PAIRED_REVERSAL_RESEARCH');
    expect(isFridayBaselinePaperExecutionAllowed(route)).toBe(false);
  });

  it('keeps an absent route non-executable', () => {
    expect(isFridayBaselinePaperExecutionAllowed('NONE')).toBe(false);
  });
});
