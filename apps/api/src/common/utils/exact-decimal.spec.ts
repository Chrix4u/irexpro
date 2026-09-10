import {
  ExactDecimal,
  ExactDecimalError,
  EXACT_DECIMAL_MAX_SCALE,
} from './exact-decimal';

/**
 * ExactDecimal boundary tests — architect issue #313 (Round 5).
 *
 * Six mandated classes:
 *   1. exact equality (float-killer boundaries — 0.1+0.2 === 0.3, ties)
 *   2. next quantum (division rounded UP / away from zero)
 *   3. previous quantum (division rounded DOWN / toward zero)
 *   4. negative values (sign preservation across every operation)
 *   5. large values (beyond float precision, no drift)
 *   6. malformed input fail-closed
 */
describe('ExactDecimal (issue #313 — exact financial arithmetic)', () => {
  const D = (v: string | number | bigint) => ExactDecimal.parse(v);

  // ─── 1. Exact equality boundaries ──────────────────────────────────────────

  describe('exact equality boundaries', () => {
    it('0.1 + 0.2 equals 0.3 exactly (binary-float killer)', () => {
      const sum = D('0.1').add(D('0.2'));
      expect(sum.eq(D('0.3'))).toBe(true);
      expect(sum.toString()).toBe('0.3');
    });

    it('daily-loss boundary: loss >= limit rejects at exact equality', () => {
      // 500 * (1.5 / 100) = 7.5 EXACTLY — no float rounding either direction
      const limit = ExactDecimal.percentOf('1.5', '500');
      expect(limit.toString()).toBe('7.5');
      expect(D('7.5').gte(limit)).toBe(true); // exact equality must reject
      expect(D('7.499999999999999999999999').lt(limit)).toBe(true);
    });

    it('margin boundary: requiredMargin > freeMargin — equality passes (strict >)', () => {
      const required = D('250.00');
      const free = D('250.0'); // same value, different representation
      expect(required.gt(free)).toBe(false); // equality must NOT reject
      expect(required.lte(free)).toBe(true);
      expect(D('250.000000001').gt(free)).toBe(true); // next quantum rejects
    });

    it('exact division terminates: 1/4 at scale 2 is exactly 0.25 in every mode', () => {
      for (const mode of ['UP', 'DOWN', 'HALF_UP', 'HALF_EVEN'] as const) {
        expect(D('1').div(D('4'), { scale: 2, mode }).toString()).toBe('0.25');
      }
    });

    it('exact division reduces canonical scale (trailing zeros stripped)', () => {
      expect(D('1').div(D('4')).toString()).toBe('0.25');
      expect(D('1').div(D('2')).toString()).toBe('0.5');
      expect(D('10').div(D('4')).toString()).toBe('2.5');
      // scale is the minimum needed: 2/4 = 0.5 at scale 1
      expect(D('2').div(D('4')).scale).toBe(1);
    });

    it('equal values with different representations compare equal', () => {
      expect(D('1.0').eq(D('1'))).toBe(true);
      expect(D('0.000').eq(D('0'))).toBe(true);
      expect(D('-0').eq(D('0'))).toBe(true);
      expect(D('1e2').eq(D('100'))).toBe(true);
      expect(D('1.23e2').eq(D('123'))).toBe(true);
      expect(D('1.23e-2').eq(D('0.0123'))).toBe(true);
      expect(D('.5').eq(D('0.5'))).toBe(true);
    });

    it('cmp is exact three-way with no epsilon', () => {
      expect(D('0.3').cmp(D('0.1').add(D('0.2')))).toBe(0);
      expect(D('0.1').cmp(D('0.2'))).toBe(-1);
      expect(D('0.2').cmp(D('0.1'))).toBe(1);
      // beyond double precision entirely
      expect(
        D('0.100000000000000000000000000001').cmp(D('0.100000000000000000000000000002')),
      ).toBe(-1);
    });
  });

  // ─── 2. Next quantum (round away from zero) ────────────────────────────────

  describe('next quantum (UP / away from zero)', () => {
    it('1/3 at scale 4 rounds UP to 0.3334 (next quantum above the true value)', () => {
      expect(D('1').divUp(D('3'), 4).toString()).toBe('0.3334');
    });

    it('2/3 at scale 4 rounds UP to 0.6667', () => {
      expect(D('2').divUp(D('3'), 4).toString()).toBe('0.6667');
    });

    it('UP never returns a value below the true quotient', () => {
      const up = D('10').divUp(D('3'), 6); // 3.333334
      expect(up.toString()).toBe('3.333334');
      // down is the true value's floor at this scale
      expect(D('10').divDown(D('3'), 6).toString()).toBe('3.333333');
      expect(up.gt(D('10').divDown(D('3'), 6)) || up.eq(D('10').divDown(D('3'), 6))).toBe(true);
    });

    it('risk-increasing boundary: drawdown % rounded UP rejects at the limit', () => {
      // (peak - equity)/peak * 100 with peak=3, equity=1 => 66.6666...%
      // limit 66.6666% — UP yields 66.6667 which is >= limit -> reject
      const peak = D('3');
      const equity = D('1');
      const drawdownPct = peak.sub(equity).mul(D('100')).divUp(peak, 6);
      expect(drawdownPct.toString()).toBe('66.666667');
      expect(drawdownPct.gte(D('66.6666'))).toBe(true);
    });

    it('HALF_UP tie rounds away from zero (next quantum)', () => {
      // 0.125 at scale 2 -> tie between 0.12 and 0.13; HALF_UP -> 0.13
      expect(D('0.125').toFixed(2, 'HALF_UP')).toBe('0.13');
      expect(D('1').div(D('8'), { scale: 2, mode: 'HALF_UP' }).toString()).toBe('0.13');
    });

    it('CEILING rounds toward +infinity (next quantum only for positive)', () => {
      expect(D('1').div(D('3'), { scale: 4, mode: 'CEILING' }).toString()).toBe('0.3334');
      expect(D('-1').div(D('3'), { scale: 4, mode: 'CEILING' }).toString()).toBe('-0.3333');
    });
  });

  // ─── 3. Previous quantum (round toward zero) ───────────────────────────────

  describe('previous quantum (DOWN / toward zero)', () => {
    it('1/3 at scale 4 rounds DOWN to 0.3333 (previous quantum below the true value)', () => {
      expect(D('1').divDown(D('3'), 4).toString()).toBe('0.3333');
    });

    it('DOWN never returns a value above the true quotient', () => {
      expect(D('2').divDown(D('3'), 4).toString()).toBe('0.6666');
      expect(D('10').divDown(D('3'), 8).toString()).toBe('3.33333333');
    });

    it('capacity boundary: available headroom rounded DOWN never over-estimates', () => {
      // freeMargin 100 / lotPrice 3 -> 33.333... lots affordable
      const affordable = D('100').divDown(D('3'), 2);
      expect(affordable.toString()).toBe('33.33');
      // 33.33 lots * 3 = 99.99 <= 100 (fits); 33.34 * 3 = 100.02 > 100 (does not)
      expect(affordable.mul(D('3')).lte(D('100'))).toBe(true);
      expect(D('33.34').mul(D('3')).gt(D('100'))).toBe(true);
    });

    it('HALF_DOWN tie rounds toward zero (previous quantum)', () => {
      expect(D('0.125').toFixed(2, 'HALF_DOWN')).toBe('0.12');
      // 1/8 = 0.125; quantized at scale 2 the unit remainder is an exact tie
      // (2r == den) -> HALF_DOWN rounds toward zero -> 0.12
      expect(D('1').div(D('8'), { scale: 2, mode: 'HALF_DOWN' }).toString()).toBe('0.12');
      // non-tie HALF_DOWN: 1/6 at scale 2 -> 16.66.. units, 2r=8 > den=6 -> bumps
      expect(D('1').div(D('6'), { scale: 2, mode: 'HALF_DOWN' }).toString()).toBe('0.17');
      // and the same input with HALF_UP agrees (past-half, not a tie)
      expect(D('1').div(D('6'), { scale: 2, mode: 'HALF_UP' }).toString()).toBe('0.17');
    });

    it('FLOOR rounds toward -infinity (previous quantum only for negative)', () => {
      expect(D('1').div(D('3'), { scale: 4, mode: 'FLOOR' }).toString()).toBe('0.3333');
      expect(D('-1').div(D('3'), { scale: 4, mode: 'FLOOR' }).toString()).toBe('-0.3334');
    });

    it('HALF_EVEN rounds ties to the even quantum', () => {
      expect(D('0.125').toFixed(2, 'HALF_EVEN')).toBe('0.12'); // 2 is even
      expect(D('0.135').toFixed(2, 'HALF_EVEN')).toBe('0.14'); // 4 is even
      expect(D('0.5').toFixed(0, 'HALF_EVEN')).toBe('0');
      expect(D('1.5').toFixed(0, 'HALF_EVEN')).toBe('2');
    });
  });

  // ─── 4. Negative values ────────────────────────────────────────────────────

  describe('negative values', () => {
    it('div UP moves AWAY from zero for negatives (-1/3 -> -0.3334)', () => {
      expect(D('-1').divUp(D('3'), 4).toString()).toBe('-0.3334');
      expect(D('1').divUp(D('-3'), 4).toString()).toBe('-0.3334');
      expect(D('-1').divUp(D('-3'), 4).toString()).toBe('0.3334');
    });

    it('div DOWN moves TOWARD zero for negatives (-1/3 -> -0.3333)', () => {
      expect(D('-1').divDown(D('3'), 4).toString()).toBe('-0.3333');
      expect(D('1').divDown(D('-3'), 4).toString()).toBe('-0.3333');
      expect(D('-1').divDown(D('-3'), 4).toString()).toBe('0.3333');
    });

    it('realised-PnL loss boundary: abs(loss) >= limit at exact negative equality', () => {
      const loss = D('-7.5'); // realised loss
      const limit = ExactDecimal.percentOf('1.5', '500'); // 7.5
      expect(loss.abs().gte(limit)).toBe(true); // exact equality rejects
      expect(D('-7.499999999999999999').abs().lt(limit)).toBe(true);
    });

    it('add/sub/mul preserve exact signs', () => {
      expect(D('-0.1').add(D('-0.2')).toString()).toBe('-0.3');
      expect(D('-1.5').sub(D('2.5')).toString()).toBe('-4');
      expect(D('-0.3').mul(D('0.2')).toString()).toBe('-0.06');
      expect(D('-0.3').mul(D('-0.2')).toString()).toBe('0.06');
    });

    it('cmp ordering holds across signs', () => {
      expect(D('-0.2').lt(D('-0.1'))).toBe(true);
      expect(D('-0.1').lt(D('0'))).toBe(true);
      expect(D('-0').eq(D('0'))).toBe(true);
    });

    it('neg and abs are exact', () => {
      expect(D('-123.456').neg().toString()).toBe('123.456');
      expect(D('123.456').neg().neg().eq(D('123.456'))).toBe(true);
      expect(D('-123.456').abs().toString()).toBe('123.456');
      expect(D('123.456').abs().toString()).toBe('123.456');
    });

    it('toFixed HALF_UP ties move away from zero for negatives too', () => {
      expect(D('-0.125').toFixed(2, 'HALF_UP')).toBe('-0.13');
      expect(D('-0.125').toFixed(2, 'HALF_EVEN')).toBe('-0.12');
    });
  });

  // ─── 5. Large values ───────────────────────────────────────────────────────

  describe('large values', () => {
    it('parses and preserves 30+ digit values exactly', () => {
      const big = D('123456789012345678901234567890.123456789');
      expect(big.toString()).toBe('123456789012345678901234567890.123456789');
      expect(big.add(D('0.000000001')).toString()).toBe(
        '123456789012345678901234567890.12345679',
      );
    });

    it('1e20-scale integer plus 0.01 stays exact (impossible in doubles)', () => {
      const v = D('100000000000000000000.01');
      expect(v.sub(D('100000000000000000000')).toString()).toBe('0.01');
      expect(v.gt(D('100000000000000000000'))).toBe(true);
    });

    it('large multiplication is exact', () => {
      const a = D('123456789.123456789');
      const b = D('987654321.987654321');
      // independently verified with Python arbitrary-precision integers
      expect(a.mul(b).toString()).toBe('121932631356500531.347203169112635269');
      // cross-check by re-dividing exactly (no remainder)
      const back = a.mul(b).divDown(a, 18);
      expect(back.eq(b)).toBe(true);
    });

    it('extreme scale bounds are enforced (fail-closed, not silent drift)', () => {
      const atLimit = D(`1e-${EXACT_DECIMAL_MAX_SCALE}`); // exactly at the cap
      expect(atLimit.toString()).toBe(`0.${'0'.repeat(EXACT_DECIMAL_MAX_SCALE - 1)}1`);
      expect(() => D(`1e-${EXACT_DECIMAL_MAX_SCALE + 1}`)).toThrow(ExactDecimalError);
      expect(() => D(`1e${EXACT_DECIMAL_MAX_SCALE + 1}`)).toThrow(ExactDecimalError);
    });

    it('big quantity * price risk multiplication stays exact', () => {
      // 1000000 units * 0.00001 price increment = 10 exactly
      expect(D('1000000').mul(D('0.00001')).toString()).toBe('10');
      // 999999999999999 * 0.0001 = 99999999999.9999
      expect(D('999999999999999').mul(D('0.0001')).toString()).toBe('99999999999.9999');
    });

    it('bigint input accepted at scale 0', () => {
      expect(D(123456789012345678901234567890n).toString()).toBe(
        '123456789012345678901234567890',
      );
      expect(D(42n).add(D('0.5')).toString()).toBe('42.5');
    });
  });

  // ─── 6. Malformed input fails closed ───────────────────────────────────────

  describe('malformed input fails closed', () => {
    const malformed: unknown[] = [
      '',
      '   ',
      ' 1',
      '1 ',
      '1\t',
      'NaN',
      'Infinity',
      '-Infinity',
      '+Infinity',
      'abc',
      '1x',
      'x1',
      '1.2.3',
      '1..2',
      '1,000',
      '1 000',
      '--1',
      '++1',
      '+-1',
      '0x10',
      '0b101',
      '1.',
      'e5',
      '1e',
      '1e+',
      '1e999999999999', // exponent out of range
      '1e-999999999999',
      '.',
      '-.',
      'null',
      'undefined',
      '1e1.5',
      '1.5e1.5',
    ];

    it.each(malformed.map((v) => [typeof v === 'string' ? `"${v}"` : String(v), v]))(
      'rejects malformed string %s',
      (_label, input) => {
        expect(() => ExactDecimal.parse(input as string)).toThrow(ExactDecimalError);
        expect(ExactDecimal.tryParse(input as string)).toBeNull();
      },
    );

    it('rejects non-finite and non-integer number inputs', () => {
      for (const bad of [NaN, Infinity, -Infinity, 0.1, -0.3, 1.5, 1e21, -1e21]) {
        expect(() => ExactDecimal.parse(bad)).toThrow(ExactDecimalError);
        expect(ExactDecimal.tryParse(bad)).toBeNull();
      }
    });

    it('accepts only safe-integer number inputs', () => {
      expect(ExactDecimal.parse(0).toString()).toBe('0');
      expect(ExactDecimal.parse(-17).toString()).toBe('-17');
      expect(ExactDecimal.parse(9007199254740991).toString()).toBe('9007199254740991');
    });

    it('rejects null / undefined / objects', () => {
      for (const bad of [null, undefined, {}, [], Symbol('x'), () => 1, true, false]) {
        expect(() => ExactDecimal.parse(bad as never)).toThrow(ExactDecimalError);
      }
    });

    it('division by zero fails closed', () => {
      expect(() => D('1').div(D('0'))).toThrow(ExactDecimalError);
      expect(() => D('1').divUp(D('0'), 4)).toThrow(ExactDecimalError);
      expect(() => D('1').divDown(D('0'), 4)).toThrow(ExactDecimalError);
      expect(() => D('0').div(D('0'))).toThrow(ExactDecimalError);
    });

    it('invalid division scale fails closed', () => {
      expect(() => D('1').div(D('3'), { scale: -1 })).toThrow(ExactDecimalError);
      expect(() => D('1').div(D('3'), { scale: 1.5 })).toThrow(ExactDecimalError);
      expect(() => D('1').div(D('3'), { scale: EXACT_DECIMAL_MAX_SCALE + 1 })).toThrow(
        ExactDecimalError,
      );
    });

    it('operations reject non-ExactDecimal operands (no silent coercion)', () => {
      const d = D('1');
      for (const bad of [
        '0.5',
        0.5,
        null,
        undefined,
        {},
      ] as never[]) {
        expect(() => d.add(bad as never)).toThrow();
        expect(() => d.cmp(bad as never)).toThrow(ExactDecimalError);
        expect(() => d.div(bad as never)).toThrow(ExactDecimalError);
      }
    });

    it('fromUnscaled validates scale', () => {
      expect(() => ExactDecimal.fromUnscaled(1n, -1)).toThrow(ExactDecimalError);
      expect(() => ExactDecimal.fromUnscaled(1n, 1.5)).toThrow(ExactDecimalError);
      expect(() => ExactDecimal.fromUnscaled(1n, EXACT_DECIMAL_MAX_SCALE + 1)).toThrow(
        ExactDecimalError,
      );
      expect(() => ExactDecimal.fromUnscaled(5 as never, 0)).toThrow(ExactDecimalError);
      expect(ExactDecimal.fromUnscaled(123n, 2).toString()).toBe('1.23');
    });
  });

  // ─── Additional contracts ──────────────────────────────────────────────────

  describe('immutability and misc contracts', () => {
    it('instances are frozen and operations return new values', () => {
      const a = D('1.5');
      const b = a.add(D('2.5'));
      expect(a.toString()).toBe('1.5'); // unchanged
      expect(b.toString()).toBe('4');
      expect(Object.isFrozen(a)).toBe(true);
      expect(() => {
        (a as { unscaled: bigint }).unscaled = 99n;
      }).toThrow();
    });

    it('percentOf is exact (no division rounding at all)', () => {
      expect(ExactDecimal.percentOf('1.5', '500').toString()).toBe('7.5');
      expect(ExactDecimal.percentOf('0.1', '0.2').toString()).toBe('0.0002'); // 0.1% of 0.2
      expect(ExactDecimal.percentOf('33.333333', '3').toString()).toBe('0.99999999');
    });

    it('divByPowerOfTen / mulByPowerOfTen are exact scale shifts', () => {
      expect(D('7.5').divByPowerOfTen(1).toString()).toBe('0.75');
      expect(D('7.5').mulByPowerOfTen(1).toString()).toBe('75');
      expect(D('7.5').mulByPowerOfTen(-1).eq(D('0.75'))).toBe(true);
      expect(() => D('7.5').divByPowerOfTen(EXACT_DECIMAL_MAX_SCALE)).toThrow(ExactDecimalError);
    });

    it('rescaling never silently loses precision', () => {
      // toFixed with a LOWER scale is explicit; rescaleTo lower throws
      expect(D('1.005').toFixed(2, 'HALF_UP')).toBe('1.01');
      // toFixed keeps the requested fixed scale (trailing zeros preserved)
      expect(D('1.005').toFixed(2, 'DOWN')).toBe('1.00');
      expect(D('1.5').toFixed(3, 'DOWN')).toBe('1.500');
    });

    it('min / max', () => {
      expect(ExactDecimal.max(D('1'), D('2')).toString()).toBe('2');
      expect(ExactDecimal.min(D('-1'), D('-2')).toString()).toBe('-2');
    });

    it('toJSON matches toString (log/JSON safe)', () => {
      expect(D('12.34').toJSON()).toBe('12.34');
      expect(JSON.stringify({ v: D('12.34') })).toBe('{"v":"12.34"}');
    });

    it('toApproximateNumber is approximate and labelled as such', () => {
      // Only display use — document by test that big values lose precision
      const big = D('123456789012345678901234567890');
      expect(big.toApproximateNumber()).toBe(1.2345678901234568e29);
    });

    it('default division contract: scale = max(a.scale, b.scale, 10), HALF_UP', () => {
      const r = D('1').div(D('3')); // default scale 10, HALF_UP
      expect(r.toString()).toBe('0.3333333333');
      const r2 = D('0.0000001').div(D('0.0000002')); // scales 7 -> default 10
      expect(r2.toString()).toBe('0.5');
    });
  });
});
