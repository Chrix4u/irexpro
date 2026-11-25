import * as shared from './multimodel-authority';
import * as legacy from './multimodel-demo-authority';

describe('shared multimodel engine identity', () => {
  it('retains the model lineage used by historical DEMO results', () => {
    expect(shared.MULTIMODEL_ENGINE_CODE).toBe('irexpro-multimodel-ensemble-v1');
    expect(legacy.MULTIMODEL_DEMO_ENGINE_CODE).toBe(shared.MULTIMODEL_ENGINE_CODE);
  });

  it('cannot diverge through legacy and shared model entry points', () => {
    expect(legacy.evaluateMultimodelDemoAuthority).toBe(shared.evaluateMultimodelAuthority);
    expect(legacy.multimodelDemoSignalConfidence).toBe(shared.multimodelSignalConfidence);
    expect(legacy.multimodelDemoExecutionVolumeCap).toBe(shared.multimodelExecutionVolumeCap);
    expect(legacy.m1CandidateToPlanBInput).toBe(shared.m1CandidateToPlanBInput);
  });
});
