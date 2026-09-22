import type {
  ManualPositionCloseOutcome,
  ManualPositionCloseResponseView,
  TradeExecutionView,
} from '@irexpro/types/execution';
import { act, renderHook } from '@testing-library/react';
import {
  closeManualPosition,
  describeManualCloseOutcome,
  manualCloseConfirmationDescription,
  manualCloseToastText,
  useManualPositionClose,
} from './manual-position-close';
import type {
  ManualCloseNotifier,
  ManualCloseToastKind,
  ManualPositionCloseTarget,
} from './manual-position-close';

/**
 * Manual single-position close tests (October UAT hardening, WS1-WEB).
 *
 * - The response contract is validated fail-closed: an unknown outcome or a
 *   malformed embedded position view throws — the UI never renders an
 *   unvalidated close result.
 * - Every honest outcome maps to an explicit toast kind + label; an unknown
 *   outcome fails closed instead of fabricating a success.
 * - The shared page controller keeps per-position pending state, blocks
 *   duplicate dispatch, toasts the honest outcome and refreshes the page
 *   after ANY completed attempt (including failures).
 */

jest.mock('@/lib/api', () => ({
  api: {
    request: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const requestMock = api.request as jest.Mock;

const TRADE_VIEW: TradeExecutionView = {
  id: 'trade-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1000',
  requestedEntryPrice: '1.10000000',
  fillPrice: '1.10010000',
  stopLoss: '1.09500000',
  takeProfit: '1.11000000',
  trailingStopPips: null,
  status: 'CLOSED',
  exitPrice: '1.10800000',
  accountCurrency: 'USD',
  realisedPnl: '79.00',
  commission: '0.50',
  swap: '0.00',
  closeReason: 'MANUAL_CLOSE',
  openedAt: '2026-10-01T09:35:00.000Z',
  closedAt: '2026-10-01T11:02:00.000Z',
  createdAt: '2026-10-01T09:34:00.000Z',
  updatedAt: '2026-10-01T11:02:00.000Z',
};

function closeResponse(
  overrides: Partial<ManualPositionCloseResponseView> = {},
): ManualPositionCloseResponseView {
  return {
    outcome: 'CLOSED',
    message: 'Position closed at market.',
    position: null,
    providerErrorClass: null,
    ...overrides,
  };
}

const TARGET: ManualPositionCloseTarget = {
  tradeId: 'trade-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1000',
};

describe('describeManualCloseOutcome (honest outcome → toast mapping)', () => {
  const cases: Array<[ManualPositionCloseOutcome, ManualCloseToastKind, string]> = [
    ['CLOSED', 'success', 'Position closed'],
    ['ALREADY_CLOSED', 'info', 'Already closed'],
    ['CLOSE_IN_PROGRESS', 'info', 'Close already in flight'],
    [
      'RECONCILIATION_REQUIRED',
      'warning',
      'Provider confirmation pending — reconciliation will resolve the final state',
    ],
    ['PROVIDER_REFUSED', 'error', 'Close failed'],
  ];

  it.each(cases)('maps %s to a %s toast titled %s', (outcome, kind, title) => {
    expect(describeManualCloseOutcome(outcome, 'server copy')).toEqual({
      kind,
      title,
      message: 'server copy',
    });
  });

  it('fails closed on an unknown outcome value (never a fabricated success)', () => {
    expect(() => describeManualCloseOutcome('MAYBE' as ManualPositionCloseOutcome, 'x')).toThrow(
      'Unknown manual close outcome',
    );
  });
});

describe('manualCloseToastText (title + the server message, never invented)', () => {
  it('composes the honest title with the server message', () => {
    const presentation = describeManualCloseOutcome('CLOSED', 'Position closed at market.');
    expect(manualCloseToastText(presentation)).toBe('Position closed. Position closed at market.');
  });

  it('falls back to the title alone when the server message is empty', () => {
    const presentation = describeManualCloseOutcome('ALREADY_CLOSED', '');
    expect(manualCloseToastText(presentation)).toBe('Already closed');
  });
});

describe('manualCloseConfirmationDescription (exact position + blast radius)', () => {
  it('names the symbol, direction and lot size and warns only this position closes', () => {
    const description = manualCloseConfirmationDescription(TARGET);
    expect(description).toContain('BUY EURUSD');
    expect(description).toContain('0.1000 lot');
    expect(description).toContain(
      'This closes only this position. Other open positions and AI Trading are not affected.',
    );
  });
});

describe('closeManualPosition runtime guards (fail-closed)', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('posts to the single-position close endpoint and validates the response', async () => {
    requestMock.mockResolvedValue(closeResponse());

    const response = await closeManualPosition('trade-1');

    expect(requestMock).toHaveBeenCalledWith('/execution/positions/trade-1/close', {
      method: 'POST',
    });
    expect(response.outcome).toBe('CLOSED');
    expect(response.position).toBeNull();
  });

  it('accepts a fully valid refreshed position view and a sanitized provider error class', async () => {
    requestMock.mockResolvedValue(
      closeResponse({
        outcome: 'PROVIDER_REFUSED',
        position: TRADE_VIEW,
        providerErrorClass: 'MARKET_CLOSED',
      }),
    );

    const response = await closeManualPosition('trade-1');

    expect(response.position?.id).toBe('trade-1');
    expect(response.providerErrorClass).toBe('MARKET_CLOSED');
  });

  it('rejects an outcome outside the contract', async () => {
    requestMock.mockResolvedValue(
      closeResponse({ outcome: 'SOMEHOW_CLOSED' as ManualPositionCloseOutcome }),
    );

    await expect(closeManualPosition('trade-1')).rejects.toThrow(
      'Manual position close contract mismatch',
    );
  });

  it('rejects a malformed embedded position view', async () => {
    requestMock.mockResolvedValue(
      closeResponse({ position: { id: 1 } as unknown as TradeExecutionView }),
    );

    await expect(closeManualPosition('trade-1')).rejects.toThrow(
      'Manual position close contract mismatch',
    );
  });

  it('rejects a non-string providerErrorClass', async () => {
    requestMock.mockResolvedValue(
      closeResponse({ providerErrorClass: 42 as unknown as string }),
    );

    await expect(closeManualPosition('trade-1')).rejects.toThrow(
      'Manual position close contract mismatch',
    );
  });
});

describe('useManualPositionClose (shared page controller)', () => {
  function makeNotify(): ManualCloseNotifier {
    return {
      success: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
    };
  }

  beforeEach(() => {
    requestMock.mockReset();
  });

  it('requests confirmation, closes with an honest toast, then refreshes the page', async () => {
    const notify = makeNotify();
    const onSettled = jest.fn();
    requestMock.mockResolvedValue(closeResponse({ message: 'Position closed at market.' }));

    const { result } = renderHook(() => useManualPositionClose({ notify, onSettled }));

    act(() => {
      result.current.requestClose(TARGET);
    });
    expect(result.current.confirmTarget).toEqual(TARGET);
    expect(result.current.isClosePending('trade-1')).toBe(false);

    await act(async () => {
      await result.current.confirmClose();
    });

    expect(notify.success).toHaveBeenCalledTimes(1);
    expect(notify.success).toHaveBeenCalledWith('Position closed. Position closed at market.');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(result.current.confirmTarget).toBeNull();
    expect(result.current.isClosePending('trade-1')).toBe(false);
  });

  it('toasts the honest RECONCILIATION_REQUIRED warning without claiming closure', async () => {
    const notify = makeNotify();
    const onSettled = jest.fn();
    requestMock.mockResolvedValue(
      closeResponse({
        outcome: 'RECONCILIATION_REQUIRED',
        message: 'Provider outcome unresolved; reconciliation owns convergence.',
      }),
    );

    const { result } = renderHook(() => useManualPositionClose({ notify, onSettled }));

    act(() => {
      result.current.requestClose(TARGET);
    });
    await act(async () => {
      await result.current.confirmClose();
    });

    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith(
      'Provider confirmation pending — reconciliation will resolve the final state. ' +
        'Provider outcome unresolved; reconciliation owns convergence.',
    );
    expect(notify.success).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('marks the position pending while in flight and blocks duplicate dispatch', async () => {
    const notify = makeNotify();
    const onSettled = jest.fn();
    let resolveClose!: (value: unknown) => void;
    requestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        }),
    );

    const { result } = renderHook(() => useManualPositionClose({ notify, onSettled }));

    act(() => {
      result.current.requestClose(TARGET);
    });

    let confirmPromise!: Promise<void>;
    act(() => {
      confirmPromise = result.current.confirmClose();
    });
    expect(result.current.isClosePending('trade-1')).toBe(true);

    // A second confirm while the first is in flight must not dispatch again.
    await act(async () => {
      await result.current.confirmClose();
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveClose(closeResponse());
      await confirmPromise;
    });
    expect(result.current.isClosePending('trade-1')).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('maps transport failures to a safe error toast and still refreshes', async () => {
    const notify = makeNotify();
    const onSettled = jest.fn();
    requestMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useManualPositionClose({ notify, onSettled }));

    act(() => {
      result.current.requestClose(TARGET);
    });
    await act(async () => {
      await result.current.confirmClose();
    });

    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith(
      'Unable to reach the server. Please check your connection.',
    );
    expect(notify.success).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(result.current.isClosePending('trade-1')).toBe(false);
  });

  it('cancelClose dismisses the confirmation without any request', async () => {
    const notify = makeNotify();
    const onSettled = jest.fn();

    const { result } = renderHook(() => useManualPositionClose({ notify, onSettled }));

    act(() => {
      result.current.requestClose(TARGET);
    });
    act(() => {
      result.current.cancelClose();
    });

    expect(result.current.confirmTarget).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
