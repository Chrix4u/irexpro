/** @deprecated Use ./multimodel-authority. No separate DEMO model implementation. */
export * from './multimodel-authority';
export {
  MULTIMODEL_ENGINE_CODE as MULTIMODEL_DEMO_ENGINE_CODE,
  evaluateMultimodelAuthority as evaluateMultimodelDemoAuthority,
  multimodelSignalConfidence as multimodelDemoSignalConfidence,
  multimodelExecutionVolumeCap as multimodelDemoExecutionVolumeCap,
} from './multimodel-authority';
export type {
  MultimodelAuthorityInput as MultimodelDemoAuthorityInput,
  MultimodelAuthorityDecision as MultimodelDemoAuthorityDecision,
  MultimodelAuthorityPath as MultimodelDemoAuthorityPath,
} from './multimodel-authority';
