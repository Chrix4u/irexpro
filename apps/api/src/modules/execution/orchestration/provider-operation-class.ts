import { ProviderOperationClass } from '../interfaces/execution-authority';
import { ExecutionIntent } from './execution-intent.interface';

/**
 * Operation-aware execution controls (Sprint 56 correction round 5, task 50-c,
 * architect issue #303).
 *
 * Every provider-bound operation is classified into a ProviderOperationClass
 * BEFORE any control-plane decision. The control gate is then CLASS-AWARE:
 *
 *   BLOCKED while kill-switch / emergency-stop is active:
 *     NEW_EXPOSURE, INCREASE_EXPOSURE, RISK_INCREASING_MODIFY
 *
 *   STILL AVAILABLE (risk-reducing / information paths must keep working so
 *   the platform can shrink exposure and reconcile during an emergency):
 *     CLOSE_POSITION, CANCEL_PENDING, RECONCILE_READ,
 *     RISK_REDUCING_MODIFY, REDUCE_EXPOSURE
 *
 * The classification is ALSO audited on every dispatch (the operation class
 * travels with the ORDER_SUBMITTED audit metadata and the final-dispatch
 * boundary's authorization audit) so post-incident review can reconstruct
 * exactly which operation class each provider call belonged to.
 */

/** Operation classes that INCREASE market exposure — control-gate blocked. */
export const EXPOSURE_INCREASING_OPERATION_CLASSES: readonly ProviderOperationClass[] = [
  ProviderOperationClass.NEW_EXPOSURE,
  ProviderOperationClass.INCREASE_EXPOSURE,
  ProviderOperationClass.RISK_INCREASING_MODIFY,
];

/** True when the operation class increases exposure (control-gate blocked). */
export function isExposureIncreasingOperation(operationClass: ProviderOperationClass): boolean {
  return EXPOSURE_INCREASING_OPERATION_CLASSES.includes(operationClass);
}

/**
 * Operation-aware kill-switch / emergency-stop policy: exposure-increasing
 * operations are blocked while a control is active; CLOSE / CANCEL /
 * RECONCILE / risk-reducing operations remain available (an active emergency
 * must never prevent the platform from REDUCING exposure or reading provider
 * truth).
 */
export function operationAllowedUnderExecutionControl(
  operationClass: ProviderOperationClass,
): boolean {
  return !isExposureIncreasingOperation(operationClass);
}

/** The provider primitives an intent can request. */
export type ProviderOperationPrimitive =
  | 'PLACE'
  | 'CLOSE_POSITION'
  | 'CANCEL_PENDING'
  | 'RECONCILE_READ'
  | 'MODIFY';

/** Classify a provider-bound operation from its primitive + effect facts. */
export function classifyProviderOperation(input: {
  providerAction: ProviderOperationPrimitive;
  /** Effect on net exposure: OPENING/INCREASING adds, CLOSING/REDUCING removes. */
  positionEffect?: 'OPENING' | 'INCREASING' | 'CLOSING' | 'REDUCING' | 'NONE';
  /** Effect on the risk of an EXISTING position (MODIFY operations). */
  riskEffect?: 'INCREASING' | 'REDUCING' | 'NEUTRAL';
}): ProviderOperationClass {
  switch (input.providerAction) {
    case 'CLOSE_POSITION':
      return ProviderOperationClass.CLOSE_POSITION;
    case 'CANCEL_PENDING':
      return ProviderOperationClass.CANCEL_PENDING;
    case 'RECONCILE_READ':
      return ProviderOperationClass.RECONCILE_READ;
    case 'MODIFY': {
      if (input.riskEffect === 'INCREASING') return ProviderOperationClass.RISK_INCREASING_MODIFY;
      if (input.riskEffect === 'REDUCING') return ProviderOperationClass.RISK_REDUCING_MODIFY;
      // Unspecified modify effect: fail-closed to the CONTROLLED class —
      // an unclassified modification is treated as risk-increasing.
      return ProviderOperationClass.RISK_INCREASING_MODIFY;
    }
    case 'PLACE': {
      if (input.positionEffect === 'CLOSING' || input.positionEffect === 'REDUCING') {
        return ProviderOperationClass.REDUCE_EXPOSURE;
      }
      if (input.positionEffect === 'INCREASING') {
        return ProviderOperationClass.INCREASE_EXPOSURE;
      }
      // Unspecified PLACE effect: the signal-pipeline PLACE intents are entry
      // orders — NEW exposure (fail-closed to the controlled class).
      return ProviderOperationClass.NEW_EXPOSURE;
    }
    default:
      // Unknown primitive — fail closed to the most conservative class.
      return ProviderOperationClass.NEW_EXPOSURE;
  }
}

/**
 * Classify an ExecutionIntent's provider-bound operation. PLACE intents from
 * the signal pipeline are entry orders → NEW_EXPOSURE; CLOSE_POSITION intents
 * (the close path) → CLOSE_POSITION.
 */
export function classifyIntentOperation(intent: ExecutionIntent): ProviderOperationClass {
  return classifyProviderOperation({
    providerAction: intent.providerAction,
  });
}
