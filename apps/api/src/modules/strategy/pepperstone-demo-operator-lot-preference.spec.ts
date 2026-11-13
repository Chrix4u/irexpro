import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluatePepperstoneDemoOperatorLotPreference as evaluate,
  PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS,
  PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS,
} from './pepperstone-demo-operator-lot-preference';

describe('owner-verified Pepperstone DEMO preferred 3–4 lots', () => {
  it('never changes LIVE, PAPER, other brokers or unverified demo order sizes', () => {
    for (const lots of ['0.01', '0.2', '1.72', '2', '3', '4', '9']) {
      expect(
        evaluate({ exactOwnerVerifiedPepperstoneDemoFullAuto: false, riskSizedLots: lots }),
      ).toMatchObject({
        applies: false,
        allowed: true,
        outcome: 'NOT_APPLICABLE',
        canIncreaseRiskOrVolume: false,
      });
    }
  });

  it.each(['0.01', '0.05', '0.2', '1.72', '2', '2.99'])(
    'blocks %s lots instead of increasing recovery / model / broker sizes',
    (riskSizedLots) => {
      expect(
        evaluate({ exactOwnerVerifiedPepperstoneDemoFullAuto: true, riskSizedLots }),
      ).toMatchObject({
        applies: true,
        allowed: false,
        outcome: 'PREFERRED_MINIMUM_NOT_AFFORDABLE',
        minimumLots: PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS,
        maximumLots: PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS,
        canIncreaseRiskOrVolume: false,
      });
    },
  );

  it.each(['3', '3.20', '3.999', '4'])(
    'keeps already risk-affordable %s lots (does not force 4)',
    (riskSizedLots) => {
      expect(
        evaluate({ exactOwnerVerifiedPepperstoneDemoFullAuto: true, riskSizedLots }),
      ).toMatchObject({
        allowed: true,
        outcome: 'ACCEPT_3_TO_4_LOTS',
        canIncreaseRiskOrVolume: false,
      });
    },
  );

  it.each(['4.01', '5', '100'])('rejects a too-large %s lot size', (riskSizedLots) => {
    expect(
      evaluate({ exactOwnerVerifiedPepperstoneDemoFullAuto: true, riskSizedLots }),
    ).toMatchObject({
      allowed: false,
      outcome: 'PREFERRED_MAXIMUM_EXCEEDED',
    });
  });

  it.each(['', 'NaN', 'Infinity', '-1', '0'])(
    'fails closed on unprovable DEMO size %s',
    (riskSizedLots) => {
      expect(
        evaluate({ exactOwnerVerifiedPepperstoneDemoFullAuto: true, riskSizedLots }),
      ).toMatchObject({
        allowed: false,
        outcome: 'SIZE_UNPROVABLE',
        riskSizedLots: null,
      });
    },
  );

  it('is used after certified owner/broker/model validation and both before sizing and allocation', () => {
    const source = readFileSync(join(__dirname, 'strategy-orchestrator.service.ts'), 'utf8');
    const auth = source.indexOf('const exactPromotedDemoBoundary =');
    const pepperstone = source.indexOf("paperConnection?.brokerId === 'pepperstone-ctrader'");
    const suggested = source.indexOf('const suggestedPreference =');
    const sizing = source.indexOf('sized = await this.positionSizingService.sizePosition({');
    const sized = source.indexOf('const sizedPreference =');
    const allocation = source.indexOf('await this.allocationService.resolveOrAllocate({');
    expect(auth).toBeGreaterThan(0);
    expect(pepperstone).toBeGreaterThan(auth);
    expect(suggested).toBeGreaterThan(pepperstone);
    expect(sizing).toBeGreaterThan(suggested);
    expect(sized).toBeGreaterThan(sizing);
    expect(allocation).toBeGreaterThan(sized);
    expect(source).toContain('DEMO_OPERATOR_LOT_PREFERENCE_BLOCKED');
    expect(source).toContain('executionCandidate.suggestedVolume');
    expect(source).toContain('riskSizedLots: sized.lots');
    expect(source).not.toContain('sized.lots =');
  });
});
