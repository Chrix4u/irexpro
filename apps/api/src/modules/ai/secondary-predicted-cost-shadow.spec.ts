import { observeSecondaryPredictedCostFloor } from './secondary-predicted-cost-shadow';

describe('secondary predicted after-cost veto research', () => {
  it('records the old threshold breach without granting execution', () => {
    expect(observeSecondaryPredictedCostFloor(-0.024, 0.2)).toEqual({
      artifact: 'secondary-predicted-cost-floor-shadow-v1',
      mode: 'SHADOW_ONLY',
      modifiesExecution: false,
      evidenceFinite: true,
      predictedNetR: -0.024,
      oldRequiredNetR: 0.2,
      wouldHaveBlocked: true,
    });
  });

  it('keeps an unprovable forecast distinguishable from a valid low forecast', () => {
    expect(observeSecondaryPredictedCostFloor(Number.NaN, 0.2)).toMatchObject({
      evidenceFinite: false,
      predictedNetR: null,
      wouldHaveBlocked: true,
    });
    expect(observeSecondaryPredictedCostFloor(0.28, 0.2)).toMatchObject({
      evidenceFinite: true,
      wouldHaveBlocked: false,
    });
  });
});
