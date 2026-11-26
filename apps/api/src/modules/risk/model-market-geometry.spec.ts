import { ExactDecimal } from '../../common/utils/exact-decimal';
import { rebaseModelMarketGeometry } from './model-market-geometry';

describe('shared pure model geometry (offline fixtures)', () => {
  it.each(['1.10006', '1.10014', '1.10009'])(
    'preserves original SELL distances at synthetic quote %s',
    (quote) => {
      const entry = ExactDecimal.parse(quote);
      const result = rebaseModelMarketGeometry({
        direction: 'SELL',
        referenceEntry: '1.10000',
        stopLoss: '1.10050',
        takeProfit: '1.09920',
        executableEntry: entry,
      });
      expect(result).not.toBeNull();
      expect(ExactDecimal.parse(result!.stopLoss).sub(entry).toString()).toBe('0.0005');
      expect(entry.sub(ExactDecimal.parse(result!.takeProfit)).toString()).toBe('0.0008');
    },
  );

  it('preserves BUY distances in the opposite direction', () => {
    expect(
      rebaseModelMarketGeometry({
        direction: 'BUY',
        referenceEntry: '1.10000',
        stopLoss: '1.09950',
        takeProfit: '1.10080',
        executableEntry: ExactDecimal.parse('1.10010'),
      }),
    ).toEqual({ stopLoss: '1.0996', takeProfit: '1.1009' });
  });

  it.each(['invalid', '0', '1.10000', '1.09900'])(
    'does not repair invalid original SELL stop geometry %s',
    (stopLoss) => {
      expect(
        rebaseModelMarketGeometry({
          direction: 'SELL',
          referenceEntry: '1.10000',
          stopLoss,
          takeProfit: '1.09920',
          executableEntry: ExactDecimal.parse('1.10010'),
        }),
      ).toBeNull();
    },
  );
});
