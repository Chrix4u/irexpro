import {
  isOct19ProvenM5PaperExecutionAllowed,
  selectPaperExecutionRoute,
} from './paper-research-throughput';

describe('Oct 19 proven M5 PAPER control', () => {
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
    expect(isOct19ProvenM5PaperExecutionAllowed(route)).toBe(true);
  });

  it('keeps the v11 PAPER research-throughput family executable under current brakes', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: false,
      paperResearchThroughputEligible: true,
      extensionExhaustionResearchEligible: false,
      pairedReversalResearchEligible: false,
    });
    expect(route).toBe('PAPER_RESEARCH_THROUGHPUT');
    expect(isOct19ProvenM5PaperExecutionAllowed(route)).toBe(true);
  });

  it('keeps extension-exhaustion M5 execution available', () => {
    const route = selectPaperExecutionRoute({
      normalPaperExecution: false,
      rejectedEdgeCanaryEligible: false,
      paperResearchThroughputEligible: false,
      extensionExhaustionResearchEligible: true,
      pairedReversalResearchEligible: false,
    });
    expect(route).toBe('PAPER_EXTENSION_EXHAUSTION_RESEARCH');
    expect(isOct19ProvenM5PaperExecutionAllowed(route)).toBe(true);
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
    expect(isOct19ProvenM5PaperExecutionAllowed(route)).toBe(false);
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
    expect(isOct19ProvenM5PaperExecutionAllowed(route)).toBe(false);
  });

  it('keeps an absent route non-executable', () => {
    expect(isOct19ProvenM5PaperExecutionAllowed('NONE')).toBe(false);
  });
});
