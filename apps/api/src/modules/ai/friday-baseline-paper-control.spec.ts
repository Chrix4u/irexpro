import { selectPaperExecutionRoute } from './paper-research-throughput';

describe('Friday baseline PAPER control', () => {
  it('keeps NORMAL_PAPER as the only executable PAPER route', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: true,
        rejectedEdgeCanaryEligible: true,
        rejectedEdgeCanaryExecutionEnabled: true,
        paperResearchThroughputEligible: true,
        extensionExhaustionResearchEligible: true,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('NORMAL_PAPER');
  });

  it('quarantines rejected-edge canary execution when NORMAL_PAPER is not eligible', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: true,
        rejectedEdgeCanaryExecutionEnabled: true,
        paperResearchThroughputEligible: false,
        extensionExhaustionResearchEligible: false,
        pairedReversalResearchEligible: false,
      }),
    ).toBe('NONE');
  });

  it('quarantines research throughput when NORMAL_PAPER is not eligible', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: true,
        extensionExhaustionResearchEligible: false,
        pairedReversalResearchEligible: false,
      }),
    ).toBe('NONE');
  });

  it('quarantines extension-exhaustion research when NORMAL_PAPER is not eligible', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: false,
        extensionExhaustionResearchEligible: true,
        pairedReversalResearchEligible: false,
      }),
    ).toBe('NONE');
  });

  it('quarantines paired-reversal research when NORMAL_PAPER is not eligible', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: false,
        extensionExhaustionResearchEligible: false,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('NONE');
  });
});
