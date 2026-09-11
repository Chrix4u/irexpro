/**
 * ExactDecimal — fixed-scale arbitrary-precision decimal arithmetic.
 *
 * Architect issue #313 (Round 5): JavaScript binary floating point must not
 * be used for authoritative money/risk comparisons. This class implements a
 * reviewed fixed-scale BigInt representation with:
 *
 *   - STRICT parsing: only canonical decimal strings (optionally signed,
 *     optional exponent), safe-integer `number` inputs, and `bigint` inputs
 *     are accepted. Everything else — NaN, Infinity, non-integer floats
 *     (whose binary value is NOT the intended decimal), empty/whitespace,
 *     thousands separators, multiple dots, trailing garbage — throws
 *     `ExactDecimalError`. Malformed values fail closed.
 *
 *   - EXACT add/sub/mul: results are always mathematically exact.
 *
 *   - QUANTIZED div: division that cannot terminate is quantized to a
 *     caller-chosen scale with an explicit, deterministic rounding mode.
 *     Raising `ExactDecimalError` on division by zero. The default mode is
 *     HALF_UP and the default scale is `max(a.scale, b.scale, 10)`, but
 *     safety-critical call sites MUST pass explicit `{ scale, mode }`
 *     (see `divUp` / `divDown` helpers for conservative boundaries).
 *
 *   - EXACT comparisons: `cmp` rescales both operands to a common scale —
 *     no epsilon, no float coercion. Boundary semantics are exact:
 *     `0.1 + 0.2` equals `0.3`; `loss.gte(limit)` rejects at exact equality;
 *     `requiredMargin.gt(freeMargin)` rejects only when strictly greater.
 *
 *   - IMMUTABLE: every operation returns a new instance; instances are
 *     frozen. Thread-safe by construction.
 *
 * Representation invariant:
 *   value = unscaled / 10^scale  (scale >= 0, <= MAX_SCALE)
 *   - no trailing zeros in `unscaled` while scale > 0 (canonical form)
 *   - zero is canonicalized to (unscaled = 0n, scale = 0)
 *   - two ExactDecimals are `eq` iff their canonical representations match
 */
export class ExactDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExactDecimalError';
  }
}

/** Rounding modes for quantized division / fixed-scale conversion. */
export type ExactDecimalRoundingMode =
  | 'UP' // away from zero — conservative for risk-increasing quantities
  | 'DOWN' // toward zero — conservative for capacity/availability quantities
  | 'CEILING' // toward +infinity
  | 'FLOOR' // toward -infinity
  | 'HALF_UP' // ties round away from zero (default; conventional)
  | 'HALF_EVEN' // ties round to even quotient (banker's rounding)
  | 'HALF_DOWN'; // ties round toward zero

export interface ExactDecimalDivOptions {
  /** Target result scale (decimal digits). Defaults to a generous exact-ish scale. */
  scale?: number;
  /** Quantization mode when the quotient is not exactly representable. */
  mode?: ExactDecimalRoundingMode;
}

/** Hard bound on scale — values beyond this are rejected (fail-closed). */
export const EXACT_DECIMAL_MAX_SCALE = 100;

/** Default division scale when the caller does not specify one. */
export const EXACT_DECIMAL_DEFAULT_DIV_SCALE = 10;

/** Strict canonical decimal grammar (no whitespace, commas, or garbage). */
const STRICT_DECIMAL_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0 || exp > EXACT_DECIMAL_MAX_SCALE) {
    throw new ExactDecimalError(`scale/exponent out of supported range: ${exp}`);
  }
  return 10n ** BigInt(exp);
}

function isCanonical(value: bigint, scale: number): boolean {
  if (!Number.isInteger(scale) || scale < 0 || scale > EXACT_DECIMAL_MAX_SCALE) {
    return false;
  }
  if (value === 0n) {
    return scale === 0;
  }
  return scale === 0 || value % 10n !== 0n;
}

export class ExactDecimal {
  private constructor(
    public readonly unscaled: bigint,
    public readonly scale: number,
  ) {
    Object.freeze(this);
  }

  // ─── Construction ──────────────────────────────────────────────────────────

  /**
   * Parse an exact decimal.
   *
   * Accepted inputs:
   *   - string matching /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/
   *     (e.g. "1234.56", "-0.0001", ".5", "+7", "1.23e2")
   *   - number: ONLY safe integers (5, -3, 0) — non-integer numbers are
   *     rejected because binary floats do not carry the caller's intended
   *     decimal value (0.1 !== 1/10 as a double). Stringify at the source.
   *   - bigint: interpreted at scale 0.
   *
   * Everything else throws ExactDecimalError (fail-closed).
   */
  static parse(input: string | number | bigint): ExactDecimal {
    if (typeof input === 'bigint') {
      return new ExactDecimal(input, 0).normalize();
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new ExactDecimalError(`non-finite number is not an exact decimal: ${input}`);
      }
      if (!Number.isInteger(input)) {
        throw new ExactDecimalError(
          `non-integer number inputs are rejected (binary floats are not exact decimals); ` +
            `pass the decimal as a string: ${input}`,
        );
      }
      if (!Number.isSafeInteger(input)) {
        throw new ExactDecimalError(
          `number input exceeds the safe integer range; pass a string or bigint: ${input}`,
        );
      }
      return new ExactDecimal(BigInt(input), 0);
    }
    if (typeof input !== 'string') {
      throw new ExactDecimalError(
        `unsupported input type: ${input === null ? 'null' : typeof input}`,
      );
    }
    const raw = input;
    if (!STRICT_DECIMAL_PATTERN.test(raw)) {
      throw new ExactDecimalError(`malformed decimal string: "${raw}"`);
    }

    // Split mantissa / exponent.
    const [mantissa, exponentPart] = (() => {
      const eIndex = raw.search(/[eE]/);
      if (eIndex === -1) {
        return [raw, ''];
      }
      return [raw.slice(0, eIndex), raw.slice(eIndex + 1)];
    })();
    const exponent = exponentPart === '' ? 0 : Number.parseInt(exponentPart, 10);

    // Mantissa digits + decimal positions.
    let digits: string;
    let decimalPositions: number;
    const dotIndex = mantissa.indexOf('.');
    if (dotIndex === -1) {
      digits = mantissa;
      decimalPositions = 0;
    } else {
      digits = mantissa.slice(0, dotIndex) + mantissa.slice(dotIndex + 1);
      decimalPositions = mantissa.length - dotIndex - 1;
    }
    const sign = digits.startsWith('-') ? -1 : 1;
    digits = digits.replace(/^[+-]/, '');

    // value = sign * digits * 10^(exponent - decimalPositions)
    const shift = exponent - decimalPositions;
    let unscaled: bigint;
    let scale: number;
    if (shift >= 0) {
      if (shift > EXACT_DECIMAL_MAX_SCALE) {
        throw new ExactDecimalError(
          `exponent shift out of supported range (>${EXACT_DECIMAL_MAX_SCALE}): "${raw}"`,
        );
      }
      unscaled = BigInt(digits) * pow10(shift);
      scale = 0;
    } else {
      scale = -shift;
      if (scale > EXACT_DECIMAL_MAX_SCALE) {
        throw new ExactDecimalError(
          `decimal scale out of supported range (>${EXACT_DECIMAL_MAX_SCALE}): "${raw}"`,
        );
      }
      unscaled = BigInt(digits);
    }
    if (sign < 0) {
      unscaled = -unscaled;
    }
    return new ExactDecimal(unscaled, scale).normalize();
  }

  /** Parse, returning null instead of throwing (for pre-validation flows). */
  static tryParse(input: string | number | bigint): ExactDecimal | null {
    try {
      return ExactDecimal.parse(input);
    } catch {
      return null;
    }
  }

  static fromUnscaled(unscaled: bigint, scale: number): ExactDecimal {
    if (typeof unscaled !== 'bigint') {
      throw new ExactDecimalError('fromUnscaled requires a bigint');
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > EXACT_DECIMAL_MAX_SCALE) {
      throw new ExactDecimalError(`invalid scale: ${scale}`);
    }
    return new ExactDecimal(unscaled, scale).normalize();
  }

  static readonly ZERO = new ExactDecimal(0n, 0);
  static readonly ONE = new ExactDecimal(1n, 0);
  static readonly HUNDRED = new ExactDecimal(100n, 0);

  /** Build from a percentage string applied to a base amount: base * pct / 100 (EXACT). */
  static percentOf(
    percent: string | number | bigint,
    base: string | number | bigint,
  ): ExactDecimal {
    return ExactDecimal.parse(base).mul(ExactDecimal.parse(percent)).divByPowerOfTen(2);
  }

  static min(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
    return a.lte(b) ? a : b;
  }

  static max(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
    return a.gte(b) ? a : b;
  }

  // ─── Normalization ─────────────────────────────────────────────────────────

  /** Strip trailing zero digits from the fractional part (canonical form). */
  private normalize(): ExactDecimal {
    let value = this.unscaled;
    let scale = this.scale;
    while (scale > 0 && value % 10n === 0n) {
      value /= 10n;
      scale -= 1;
    }
    if (value === 0n) {
      scale = 0;
    }
    if (isCanonical(value, scale)) {
      return new ExactDecimal(value, scale);
    }
    throw new ExactDecimalError('normalization produced an invalid representation');
  }

  private rescaleTo(targetScale: number): ExactDecimal {
    if (targetScale === this.scale) {
      return this;
    }
    if (targetScale < this.scale) {
      throw new ExactDecimalError(
        `rescale to lower scale would lose precision (${this.scale} -> ${targetScale}); ` +
          `use toFixed with an explicit rounding mode instead`,
      );
    }
    return new ExactDecimal(this.unscaled * pow10(targetScale - this.scale), targetScale);
  }

  // ─── Arithmetic (exact) ────────────────────────────────────────────────────

  add(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.scale, other.scale);
    return new ExactDecimal(
      this.rescaleTo(scale).unscaled + other.rescaleTo(scale).unscaled,
      scale,
    ).normalize();
  }

  sub(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.scale, other.scale);
    return new ExactDecimal(
      this.rescaleTo(scale).unscaled - other.rescaleTo(scale).unscaled,
      scale,
    ).normalize();
  }

  mul(other: ExactDecimal): ExactDecimal {
    return new ExactDecimal(this.unscaled * other.unscaled, this.scale + other.scale).normalize();
  }

  neg(): ExactDecimal {
    return new ExactDecimal(-this.unscaled, this.scale);
  }

  abs(): ExactDecimal {
    return this.unscaled < 0n ? this.neg() : this;
  }

  /** Exact multiplication by a power of ten (e.g. percent denominators). */
  mulByPowerOfTen(exp: number): ExactDecimal {
    if (!Number.isInteger(exp)) {
      throw new ExactDecimalError(`power-of-ten exponent must be an integer: ${exp}`);
    }
    if (exp >= 0) {
      if (this.scale >= exp) {
        return new ExactDecimal(this.unscaled, this.scale - exp).normalize();
      }
      return new ExactDecimal(this.unscaled * pow10(exp - this.scale), 0);
    }
    return this.divByPowerOfTen(-exp);
  }

  /** Exact division by a power of ten (increases scale; never loses precision). */
  divByPowerOfTen(exp: number): ExactDecimal {
    if (!Number.isInteger(exp)) {
      throw new ExactDecimalError(`power-of-ten exponent must be an integer: ${exp}`);
    }
    if (exp < 0) {
      return this.mulByPowerOfTen(-exp);
    }
    const targetScale = this.scale + exp;
    if (targetScale > EXACT_DECIMAL_MAX_SCALE) {
      throw new ExactDecimalError(`scale out of supported range after dividing by 10^${exp}`);
    }
    return new ExactDecimal(this.unscaled, targetScale).normalize();
  }

  // ─── Division (quantized) ──────────────────────────────────────────────────

  /**
   * Divide, quantizing to `options.scale` decimal digits using
   * `options.mode` when the quotient is not exactly representable.
   *
   * Division by zero throws ExactDecimalError (fail-closed).
   *
   * Default mode: 'HALF_UP'. Default scale: max(a.scale, b.scale, 10).
   * Safety-critical boundaries should use divUp / divDown explicitly.
   */
  div(divisor: ExactDecimal, options: ExactDecimalDivOptions = {}): ExactDecimal {
    if (!(divisor instanceof ExactDecimal)) {
      throw new ExactDecimalError('divisor must be an ExactDecimal');
    }
    if (divisor.unscaled === 0n) {
      throw new ExactDecimalError('division by zero');
    }
    const mode: ExactDecimalRoundingMode = options.mode ?? 'HALF_UP';
    const scale =
      options.scale ?? Math.max(this.scale, divisor.scale, EXACT_DECIMAL_DEFAULT_DIV_SCALE);
    if (!Number.isInteger(scale) || scale < 0 || scale > EXACT_DECIMAL_MAX_SCALE) {
      throw new ExactDecimalError(`invalid division scale: ${scale}`);
    }

    // a/b = (ua * 10^sb) / (ub * 10^sa);  u/10^scale = a/b
    //   => u = (ua * 10^(sb + scale)) / (ub * 10^sa)
    const num = this.unscaled * pow10(divisor.scale + scale);
    const den = divisor.unscaled * pow10(this.scale);

    return new ExactDecimal(quantizedDivide(num, den, mode), scale).normalize();
  }

  /**
   * Divide rounding AWAY FROM ZERO at the given scale.
   * Conservative for quantities that INCREASE risk (loss, required margin,
   * drawdown): the computed value can only grow, so boundary comparisons
   * like `value >= limit` reject at exact equality and never under-reject.
   */
  divUp(divisor: ExactDecimal, scale: number): ExactDecimal {
    return this.div(divisor, { scale, mode: 'UP' });
  }

  /**
   * Divide rounding TOWARD ZERO at the given scale.
   * Conservative for quantities that represent CAPACITY/availability:
   * the computed value can only shrink, so comparisons against limits
   * never over-estimate available headroom.
   */
  divDown(divisor: ExactDecimal, scale: number): ExactDecimal {
    return this.div(divisor, { scale, mode: 'DOWN' });
  }

  // ─── Comparisons (exact) ───────────────────────────────────────────────────

  /** Exact three-way comparison: -1 | 0 | 1. No epsilon. */
  cmp(other: ExactDecimal): -1 | 0 | 1 {
    if (!(other instanceof ExactDecimal)) {
      throw new ExactDecimalError('comparison target must be an ExactDecimal');
    }
    const scale = Math.max(this.scale, other.scale);
    const a = this.rescaleTo(scale).unscaled;
    const b = other.rescaleTo(scale).unscaled;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  eq(other: ExactDecimal): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: ExactDecimal): boolean {
    return this.cmp(other) === -1;
  }

  lte(other: ExactDecimal): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: ExactDecimal): boolean {
    return this.cmp(other) === 1;
  }

  gte(other: ExactDecimal): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  isNegative(): boolean {
    return this.unscaled < 0n;
  }

  isPositive(): boolean {
    return this.unscaled > 0n;
  }

  // ─── Conversion ────────────────────────────────────────────────────────────

  /** Canonical string: no exponent, no trailing fractional zeros. */
  toString(): string {
    const negative = this.unscaled < 0n;
    const digits = (negative ? -this.unscaled : this.unscaled).toString();
    if (this.scale === 0) {
      return negative ? `-${digits}` : digits;
    }
    const padded = digits.padStart(this.scale + 1, '0');
    const intPart = padded.slice(0, padded.length - this.scale);
    const fracPart = padded.slice(padded.length - this.scale);
    const combined = `${negative ? '-' : ''}${intPart}.${fracPart}`;
    return combined;
  }

  toJSON(): string {
    return this.toString();
  }

  /**
   * Quantize to a fixed number of fractional digits (display / persistence
   * formatting). Rounds with the given mode (default HALF_UP). Never used
   * for comparisons — compare ExactDecimals directly.
   */
  toFixed(scale: number, mode: ExactDecimalRoundingMode = 'HALF_UP'): string {
    if (!Number.isInteger(scale) || scale < 0 || scale > EXACT_DECIMAL_MAX_SCALE) {
      throw new ExactDecimalError(`invalid toFixed scale: ${scale}`);
    }
    if (scale === this.scale) {
      return this.toString();
    }
    if (scale > this.scale) {
      return this.rescaleTo(scale).toString();
    }
    const shift = this.scale - scale;
    const num = this.unscaled;
    const den = pow10(shift);
    const quantized = quantizedDivide(num, den, mode);
    return new ExactDecimal(quantized, scale).toString();
  }

  /**
   * Approximate JS number — DISPLAY / logging ONLY.
   * Never use for authoritative money/risk comparisons (issue #313).
   */
  toApproximateNumber(): number {
    return Number(this.toString());
  }
}

/**
 * Divide `num / den` at integer precision, applying the rounding mode to the
 * truncated quotient. `num` and `den` are BigInts; den !== 0n.
 */
function quantizedDivide(num: bigint, den: bigint, mode: ExactDecimalRoundingMode): bigint {
  // BigInt division truncates toward zero; remainder takes the dividend's sign.
  const q = num / den;
  const r = num % den;
  if (r === 0n) {
    return q;
  }

  const negativeResult = num < 0n !== den < 0n;
  // Direction that moves the magnitude away from zero.
  const awayFromZero = negativeResult ? -1n : 1n;

  const absR = r < 0n ? -r : r;
  const absDen = den < 0n ? -den : den;
  const twiceR = absR * 2n;

  switch (mode) {
    case 'UP':
      return q + awayFromZero;
    case 'DOWN':
      return q;
    case 'CEILING':
      return negativeResult ? q : q + 1n;
    case 'FLOOR':
      return negativeResult ? q - 1n : q;
    case 'HALF_UP':
      return twiceR >= absDen ? q + awayFromZero : q;
    case 'HALF_DOWN':
      return twiceR > absDen ? q + awayFromZero : q;
    case 'HALF_EVEN': {
      if (twiceR > absDen) {
        return q + awayFromZero;
      }
      if (twiceR < absDen) {
        return q;
      }
      // Exact tie — round to the even quotient.
      const absQ = q < 0n ? -q : q;
      return absQ % 2n === 0n ? q : q + awayFromZero;
    }
    default: {
      const exhaustive: never = mode;
      throw new ExactDecimalError(`unknown rounding mode: ${String(exhaustive)}`);
    }
  }
}
