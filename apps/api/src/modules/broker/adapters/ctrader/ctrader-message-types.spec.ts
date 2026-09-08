import {
  addDecimalStrings,
  buildIdempotencyFields,
  contractTimeInForceToProto,
  CTRADER_ENVIRONMENT_URLS,
  CTRADER_HISTORICAL_PAYLOAD_TYPES,
  CTRADER_PAYLOAD_TYPE,
  CTRADER_TRENDBAR_PERIODS,
  decimalStringToWirePrice,
  expectCtraderPayload,
  mapCtraderError,
  moneyToDecimalString,
  parseCtraderId,
  percentageRatioString,
  protoTimeInForceToString,
  spotMidPrice,
  spotToPrice,
  subtractDecimalStrings,
  unitsToVolumeCents,
  volumeCentsToLotString,
  wirePriceToDecimalString,
} from './ctrader-message-types';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

describe('ctrader-message-types', () => {
  // ─── Volume conversions (lots ⇄ cents via the SYMBOL lotSize) ──────────────

  describe('unitsToVolumeCents', () => {
    it('converts 1.5 FX lots to 15 000 000 volume cents', () => {
      expect(unitsToVolumeCents('1.5', 10_000_000)).toBe(15_000_000);
    });

    it('converts 0.10 lots to 1 000 000 cents (10 000 units)', () => {
      expect(unitsToVolumeCents('0.10', 10_000_000)).toBe(1_000_000);
    });

    it('converts whole lots exactly', () => {
      expect(unitsToVolumeCents('1', 10_000_000)).toBe(10_000_000);
      expect(unitsToVolumeCents('2', 10_000_000)).toBe(20_000_000);
    });

    it('uses the symbol lot size (a 100-cent lot symbol)', () => {
      expect(unitsToVolumeCents('1', 100)).toBe(100);
      expect(unitsToVolumeCents('0.01', 10_000_000)).toBe(100_000);
    });

    it('fails closed with INVALID_LOT_SIZE for non-representable volumes', () => {
      // 0.0000001 lots × 10 000 000 = 1 cent — representable;
      // 0.00000005 × 10 000 000 = 0.5 cents — NOT whole cents.
      expect(() => unitsToVolumeCents('0.00000005', 10_000_000)).toThrow(BrokerAdapterError);
      expect(() => unitsToVolumeCents('0.00000005', 10_000_000)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.INVALID_LOT_SIZE }),
      );
    });

    it('fails closed for malformed lot strings', () => {
      for (const bad of ['', 'abc', '1.2.3', '1e5', null, undefined]) {
        expect(() => unitsToVolumeCents(bad as string, 10_000_000)).toThrow(
          expect.objectContaining({ code: BrokerErrorCode.INVALID_LOT_SIZE }),
        );
      }
    });

    it('fails closed for a non-positive symbol lot size', () => {
      expect(() => unitsToVolumeCents('1', 0)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.INVALID_INSTRUMENT }),
      );
      expect(() => unitsToVolumeCents('1', -5)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.INVALID_INSTRUMENT }),
      );
    });
  });

  describe('volumeCentsToLotString', () => {
    it('converts cents back into exact lot strings', () => {
      expect(volumeCentsToLotString(15_000_000, 10_000_000)).toBe('1.5');
      expect(volumeCentsToLotString(1_000_000, 10_000_000)).toBe('0.1');
      expect(volumeCentsToLotString(10_000_000, 10_000_000)).toBe('1');
      expect(volumeCentsToLotString(0, 10_000_000)).toBe('0');
      expect(volumeCentsToLotString(2_000, 100)).toBe('20');
    });

    it('rounds non-terminating ratios half-up at the 12th fractional digit', () => {
      // 2 000 000 / 6 000 000 = 0.333… (non-terminating denominator).
      const result = volumeCentsToLotString(2_000_000, 6_000_000);
      expect(result.startsWith('0.333333333333')).toBe(true);
    });
  });

  // ─── Spot prices (1/100 000 of a price unit) ───────────────────────────────

  describe('spotToPrice', () => {
    it('converts 108650 to "1.08650"', () => {
      expect(spotToPrice(108650)).toBe('1.08650');
    });

    it('handles high-value instruments and negative relative distances', () => {
      expect(spotToPrice(212345000)).toBe('2123.45000');
      expect(spotToPrice(-53423782)).toBe('-534.23782');
    });

    it('converts the documented relative example 123000 → "1.23000"', () => {
      expect(spotToPrice(123000)).toBe('1.23000');
    });
  });

  describe('spotMidPrice', () => {
    it('computes the exact midpoint of two spot values', () => {
      expect(spotMidPrice(108650, 108700)).toBe('1.08675');
    });

    it('keeps the extra digit when the midpoint needs it', () => {
      // (1.0865 + 1.08651) / 2 = 1.086505
      expect(spotMidPrice(108650, 108651)).toBe('1.086505');
    });
  });

  // ─── Money (int64 + moneyDigits exponent) ─────────────────────────────────

  describe('moneyToDecimalString', () => {
    it('converts the documented example 10053099944/10^8 → "100.53099944"', () => {
      expect(moneyToDecimalString(10_053_099_944, 8)).toBe('100.53099944');
    });

    it('zero-pads to the moneyDigits precision', () => {
      expect(moneyToDecimalString(0, 2)).toBe('0.00');
      expect(moneyToDecimalString(500000, 2)).toBe('5000.00');
      expect(moneyToDecimalString(5, 8)).toBe('0.00000005');
    });

    it('supports moneyDigits 0 and negative balances', () => {
      expect(moneyToDecimalString(10053099944, 0)).toBe('10053099944');
      expect(moneyToDecimalString(-10053099944, 8)).toBe('-100.53099944');
    });
  });

  describe('decimal string arithmetic', () => {
    it('adds exact decimal money strings', () => {
      expect(addDecimalStrings('100.53', '0.47')).toBe('101.00');
      expect(addDecimalStrings('100.53099944', '-0.53099944')).toBe('100.00000000');
      expect(addDecimalStrings('0.10', '0.20')).toBe('0.30');
    });

    it('subtracts exact decimal money strings', () => {
      expect(subtractDecimalStrings('100.53', '0.53')).toBe('100.00');
      expect(subtractDecimalStrings('0.5', '1')).toBe('-0.5');
    });

    it('computes margin-level percentage ratios with 2 decimals', () => {
      expect(percentageRatioString('1200', '600')).toBe('200.00');
      expect(percentageRatioString('1', '3')).toBe('33.33');
      expect(percentageRatioString('100', '0')).toBe('0');
    });
  });

  // ─── Wire price helpers ────────────────────────────────────────────────────

  describe('decimalStringToWirePrice', () => {
    it('converts decimal strings to protocol doubles', () => {
      expect(decimalStringToWirePrice('1.08650', 'limitPrice')).toBeCloseTo(1.0865, 7);
    });

    it('fails closed for non-positive or malformed prices', () => {
      expect(() => decimalStringToWirePrice('0', 'stopLoss')).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.INVALID_PRICE }),
      );
      expect(() => decimalStringToWirePrice('-1', 'stopLoss')).toThrow(BrokerAdapterError);
      expect(() => decimalStringToWirePrice('nope', 'stopLoss')).toThrow(BrokerAdapterError);
    });
  });

  describe('time-in-force mapping (contract union ⇄ ProtoOATimeInForce)', () => {
    it('maps GTC/DAY/IOC/FOK onto the proto enum values', () => {
      expect(contractTimeInForceToProto('GTC')).toBe(2); // GOOD_TILL_CANCEL
      expect(contractTimeInForceToProto('DAY')).toBe(1); // GOOD_TILL_DATE
      expect(contractTimeInForceToProto('IOC')).toBe(3); // IMMEDIATE_OR_CANCEL
      expect(contractTimeInForceToProto('FOK')).toBe(4); // FILL_OR_KILL
    });

    it('maps proto values back onto the contract union (MARKET_ON_OPEN by name)', () => {
      expect(protoTimeInForceToString(2)).toBe('GTC');
      expect(protoTimeInForceToString(1)).toBe('DAY');
      expect(protoTimeInForceToString(3)).toBe('IOC');
      expect(protoTimeInForceToString(4)).toBe('FOK');
      expect(protoTimeInForceToString(5)).toBe('MARKET_ON_OPEN');
      expect(protoTimeInForceToString(undefined)).toBeNull();
      expect(protoTimeInForceToString(99)).toBe('99'); // unrecognized → verbatim
    });
  });

  describe('wirePriceToDecimalString', () => {
    it('formats wire doubles as decimal strings and defaults absent to "0"', () => {
      expect(wirePriceToDecimalString(1.08651)).toBe('1.08651');
      expect(wirePriceToDecimalString(undefined)).toBe('0');
      expect(wirePriceToDecimalString(null)).toBe('0');
    });

    it('fails closed on non-finite prices', () => {
      expect(() => wirePriceToDecimalString(Number.POSITIVE_INFINITY)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.BROKER_SERVER_ERROR }),
      );
    });
  });

  // ─── int64 id safety ───────────────────────────────────────────────────────

  describe('parseCtraderId', () => {
    it('accepts JSON numbers and digit strings', () => {
      expect(parseCtraderId(1234567, 'id')).toBe(1234567);
      expect(parseCtraderId('1234567', 'id')).toBe(1234567);
    });

    it('throws a typed BROKER_SERVER_ERROR for unsafe int64 ids', () => {
      const unsafe = Number.MAX_SAFE_INTEGER + 1;
      expect(() => parseCtraderId(unsafe, 'ctidTraderAccountId')).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.BROKER_SERVER_ERROR }),
      );
      expect(() => parseCtraderId('9007199254740993', 'orderId')).toThrow(BrokerAdapterError);
      expect(() => parseCtraderId(undefined, 'orderId')).toThrow(BrokerAdapterError);
      expect(() => parseCtraderId({ id: 1 }, 'orderId')).toThrow(BrokerAdapterError);
    });
  });

  // ─── Idempotency propagation (proto field limits) ──────────────────────────

  describe('buildIdempotencyFields', () => {
    it('places the idempotency key into clientOrderId, label and comment', () => {
      const fields = buildIdempotencyFields('idem-key-001');
      expect(fields).toEqual({
        clientOrderId: 'idem-key-001',
        label: 'idem-key-001',
        comment: 'idem-key-001',
      });
    });

    it('truncates safely to the proto limits (50/100/512 chars)', () => {
      const key = 'x'.repeat(600);
      const fields = buildIdempotencyFields(key);
      expect(fields.clientOrderId).toHaveLength(50);
      expect(fields.label).toHaveLength(100);
      expect(fields.comment).toHaveLength(512);
      expect(fields.clientOrderId).toBe('x'.repeat(50));
    });
  });

  // ─── Error-code mapping (single place, names AND defensive numbers) ────────

  describe('mapCtraderError', () => {
    it.each([
      ['NOT_ENOUGH_MONEY', BrokerErrorCode.INSUFFICIENT_MARGIN],
      [118, BrokerErrorCode.INSUFFICIENT_MARGIN],
      ['TRADING_BAD_VOLUME', BrokerErrorCode.INVALID_LOT_SIZE],
      [125, BrokerErrorCode.INVALID_LOT_SIZE],
      ['SYMBOL_NOT_FOUND', BrokerErrorCode.INVALID_INSTRUMENT],
      [114, BrokerErrorCode.INVALID_INSTRUMENT],
      ['MARKET_CLOSED', BrokerErrorCode.MARKET_CLOSED],
      [9, BrokerErrorCode.MARKET_CLOSED],
      ['CH_CLIENT_AUTH_FAILURE', BrokerErrorCode.AUTHENTICATION_FAILED],
      ['CH_ACCESS_TOKEN_INVALID', BrokerErrorCode.AUTHENTICATION_FAILED],
      [104, BrokerErrorCode.AUTHENTICATION_FAILED],
      ['REQUEST_FREQUENCY_EXCEEDED', BrokerErrorCode.RATE_LIMITED],
      [108, BrokerErrorCode.RATE_LIMITED],
      ['BLOCKED_PAYLOAD_TYPE', BrokerErrorCode.RATE_LIMITED],
      ['POSITION_NOT_FOUND', BrokerErrorCode.POSITION_NOT_FOUND],
      ['ORDER_NOT_FOUND', BrokerErrorCode.POSITION_NOT_FOUND],
      ['PROTECTION_IS_TOO_CLOSE_TO_MARKET', BrokerErrorCode.INVALID_REQUEST],
      ['PENDING_EXECUTION', BrokerErrorCode.BROKER_SERVER_ERROR],
      ['SOME_UNKNOWN_CODE', BrokerErrorCode.UNKNOWN],
    ])('maps %s → %s', (errorCode, expected) => {
      const mapped = mapCtraderError(errorCode);
      expect(mapped.code).toBe(expected);
      expect(mapped).toBeInstanceOf(BrokerAdapterError);
    });

    it('marks retryable codes as retryable', () => {
      expect(mapCtraderError('REQUEST_FREQUENCY_EXCEEDED').isRetryable).toBe(true);
      expect(mapCtraderError('SERVER_IS_UNDER_MAINTENANCE').isRetryable).toBe(true);
      expect(mapCtraderError('NOT_ENOUGH_MONEY').isRetryable).toBe(false);
    });

    it('redacts credential-shaped provider text out of the message', () => {
      const secret = 'SK_CTRADER_LEAK_9f8e7d6c';
      const mapped = mapCtraderError('CH_CLIENT_AUTH_FAILURE', `apiKey=${secret} rejected`);
      expect(mapped.message).not.toContain(secret);
      expect(mapped.brokerMessage ?? '').not.toContain(secret);
      expect(mapped.message).toContain('[REDACTED]');
    });

    it('falls back to the error name when no description exists', () => {
      const mapped = mapCtraderError('MARKET_CLOSED');
      expect(mapped.message).toBe('cTrader error: MARKET_CLOSED');
    });
  });

  // ─── Constants sanity (protocol facts) ─────────────────────────────────────

  describe('protocol constants', () => {
    it('pins the payloadType numbers used on the wire', () => {
      expect(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ).toBe(2100);
      expect(CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ).toBe(2102);
      expect(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ).toBe(2106);
      expect(CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT).toBe(2126);
      expect(CTRADER_PAYLOAD_TYPE.SPOT_EVENT).toBe(2131);
      expect(CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ).toBe(2133);
      expect(CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_REQ).toBe(2139);
      expect(CTRADER_PAYLOAD_TYPE.OA_ERROR_RES).toBe(2142);
      expect(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ).toBe(2149);
      // Order-state reconciliation surface (Sprint 50 PR-4 port).
      expect(CTRADER_PAYLOAD_TYPE.ORDER_LIST_REQ).toBe(2175);
      expect(CTRADER_PAYLOAD_TYPE.ORDER_LIST_RES).toBe(2176);
      expect(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ).toBe(2181);
      expect(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES).toBe(2182);
      expect(CTRADER_PAYLOAD_TYPE.PROTO_ERROR_RES).toBe(50);
      expect(CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT).toBe(51);
    });

    it('pins the demo/live host isolation URLs', () => {
      expect(CTRADER_ENVIRONMENT_URLS.DEMO).toBe('wss://demo.ctraderapi.com:5036');
      expect(CTRADER_ENVIRONMENT_URLS.LIVE).toBe('wss://live.ctraderapi.com:5036');
      expect(CTRADER_ENVIRONMENT_URLS.DEMO).not.toContain('live');
    });

    it('marks the historical rate-limit payload types', () => {
      expect(CTRADER_HISTORICAL_PAYLOAD_TYPES.has(2133)).toBe(true); // DealList
      expect(CTRADER_HISTORICAL_PAYLOAD_TYPES.has(2137)).toBe(true); // Trendbars
      expect(CTRADER_HISTORICAL_PAYLOAD_TYPES.has(2145)).toBe(true); // TickData
      expect(CTRADER_HISTORICAL_PAYLOAD_TYPES.has(2175)).toBe(true); // OrderList
      expect(CTRADER_HISTORICAL_PAYLOAD_TYPES.has(2121)).toBe(false); // general
    });

    it('pins the trendbar period enum values (M1=1 … MN1=14)', () => {
      expect(CTRADER_TRENDBAR_PERIODS.M1).toBe(1);
      expect(CTRADER_TRENDBAR_PERIODS.M5).toBe(5);
      expect(CTRADER_TRENDBAR_PERIODS.M15).toBe(7);
      expect(CTRADER_TRENDBAR_PERIODS.H1).toBe(9);
      expect(CTRADER_TRENDBAR_PERIODS.D1).toBe(12);
      expect(CTRADER_TRENDBAR_PERIODS.MN1).toBe(14);
    });
  });

  // ─── Response narrowing ────────────────────────────────────────────────────

  describe('expectCtraderPayload', () => {
    it('returns the payload when the payloadType matches', () => {
      const payload = expectCtraderPayload<{ trader: unknown }>(
        { payloadType: 2122, payload: { trader: {} } },
        2122,
      );
      expect(payload.trader).toEqual({});
    });

    it('fails closed on a payloadType mismatch or missing payload', () => {
      expect(() => expectCtraderPayload({ payloadType: 2126, payload: {} }, 2122)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.BROKER_SERVER_ERROR }),
      );
      expect(() => expectCtraderPayload({ payloadType: 2122 }, 2122)).toThrow(BrokerAdapterError);
    });
  });
});
