import { canonicalSignalPrice } from './canonical-signal-price';

describe('canonicalSignalPrice', () => {
  it('removes the recorded EURUSD binary arithmetic artifact before risk authorization', () => {
    expect(String(canonicalSignalPrice(1.0907600000000002))).toBe('1.09076');
    expect(String(canonicalSignalPrice(1.09206))).toBe('1.09206');
  });
  it.each([1.090765, 1.09076001, 1.09075999, 150.123456, 0, -1, Infinity, NaN])(
    'does not round a genuinely off-grid or invalid value %p',
    (value) => expect(canonicalSignalPrice(value)).toBe(value),
  );
  it('handles arithmetic residue on JPY prices', () => {
    expect(canonicalSignalPrice(150.12345000000003)).toBe(150.12345);
  });
});
