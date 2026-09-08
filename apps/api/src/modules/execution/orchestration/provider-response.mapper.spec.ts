import { mapProviderOrderResponse } from './provider-response.mapper';
import { BrokerOrderResult } from '../../broker/interfaces/broker-adapter.interface';

/**
 * Sprint 50 PR-3 — Directive PHASE D "response handling".
 * The pure mapping table from provider BrokerOrderResult to the
 * order-domain action. Single source of truth for every dispatch outcome.
 */
describe('mapProviderOrderResponse', () => {
  const base: BrokerOrderResult = {
    success: true,
    status: 'FILLED',
  };

  describe('FILLED results', () => {
    it('success + price → ACKNOWLEDGE_AND_FILL with provider id and quantities', () => {
      const action = mapProviderOrderResponse({
        ...base,
        externalOrderId: 'pos-1',
        filledPrice: '1.08500',
        filledQuantity: '0.05',
      });
      expect(action).toEqual({
        action: 'ACKNOWLEDGE_AND_FILL',
        providerOrderId: 'pos-1',
        fillQuantity: '0.05',
        fillPrice: '1.08500',
      });
    });

    it('success + price, no provider id → fill allowed (id recorded if known later)', () => {
      const action = mapProviderOrderResponse({
        ...base,
        filledPrice: '1.08500',
      });
      expect(action.action).toBe('ACKNOWLEDGE_AND_FILL');
    });

    it('success but MISSING fill price → RECONCILIATION_PENDING (fail-closed: outcome unknown)', () => {
      const action = mapProviderOrderResponse({
        ...base,
        externalOrderId: 'pos-1',
        filledPrice: undefined,
      });
      expect(action).toEqual({
        action: 'RECONCILIATION_PENDING',
        reason: 'Provider reported FILLED without a fill price — outcome cannot be recorded',
      });
    });

    it('success=false → REJECT (definitive non-execution)', () => {
      const action = mapProviderOrderResponse({
        ...base,
        success: false,
        brokerMessage: 'retcode failure',
      });
      expect(action).toEqual({
        action: 'REJECT',
        reason: 'retcode failure',
      });
    });
  });

  describe('PENDING results', () => {
    it('success + provider id → ACKNOWLEDGE (working order at provider)', () => {
      const action = mapProviderOrderResponse({
        success: true,
        status: 'PENDING',
        externalOrderId: 'ord-77',
      });
      expect(action).toEqual({
        action: 'ACKNOWLEDGE',
        providerOrderId: 'ord-77',
      });
    });

    it('success but MISSING provider id → RECONCILIATION_PENDING (cannot track)', () => {
      const action = mapProviderOrderResponse({
        success: true,
        status: 'PENDING',
      });
      expect(action).toEqual({
        action: 'RECONCILIATION_PENDING',
        reason: 'Provider reported PENDING without a provider order id — outcome cannot be tracked',
      });
    });

    it('success=false → REJECT', () => {
      const action = mapProviderOrderResponse({
        success: false,
        status: 'PENDING',
        brokerMessage: 'no money',
      });
      expect(action).toEqual({ action: 'REJECT', reason: 'no money' });
    });
  });

  describe('REJECTED results', () => {
    it('→ REJECT with broker message', () => {
      const action = mapProviderOrderResponse({
        success: false,
        status: 'REJECTED',
        brokerMessage: 'Invalid price (10004)',
      });
      expect(action).toEqual({ action: 'REJECT', reason: 'Invalid price (10004)' });
    });

    it('→ REJECT with default reason when message absent', () => {
      const action = mapProviderOrderResponse({ success: false, status: 'REJECTED' });
      expect(action).toEqual({ action: 'REJECT', reason: 'Order rejected by provider' });
    });
  });

  describe('FAILED results', () => {
    it('→ REJECT (provider answered: not executed)', () => {
      const action = mapProviderOrderResponse({
        success: false,
        status: 'FAILED',
        brokerMessage: 'TRADE_RETCODE_INVALID',
      });
      expect(action).toEqual({ action: 'REJECT', reason: 'TRADE_RETCODE_INVALID' });
    });

    it('→ REJECT with default reason when message absent', () => {
      const action = mapProviderOrderResponse({ success: false, status: 'FAILED' });
      expect(action).toEqual({ action: 'REJECT', reason: 'Order failed at provider' });
    });
  });
});
