import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ClosePositionButton } from './ClosePositionButton';
import type {
  ManualPositionCloseController,
  ManualPositionCloseTarget,
} from '@/lib/manual-position-close';

/**
 * ClosePositionButton tests (October UAT hardening, WS1-WEB).
 *
 * - OPEN positions render the small danger close affordance; reconciliation-
 *   pending positions render a muted note instead — never an active control.
 * - Clicking asks the shared page controller for confirmation; the dialog
 *   names the exact position and states the blast radius.
 * - While a close is in flight for the position, the button disables.
 *
 * The controller is stubbed (the real hook behaviour is covered by
 * manual-position-close.spec.ts); the api transport is mocked so importing
 * the lib module never touches the real environment-dependent client.
 */

jest.mock('@/lib/api', () => ({
  api: {
    request: jest.fn(),
  },
}));

const TARGET: ManualPositionCloseTarget = {
  tradeId: 'trade-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1000',
};

function buildController(overrides: {
  pending?: boolean;
  confirmTarget?: ManualPositionCloseTarget | null;
} = {}): ManualPositionCloseController {
  const pendingIds = new Set(overrides.pending ? [TARGET.tradeId] : []);
  return {
    pendingTradeIds: pendingIds,
    isClosePending: (tradeId) => pendingIds.has(tradeId),
    confirmTarget: overrides.confirmTarget ?? null,
    requestClose: jest.fn(),
    cancelClose: jest.fn(),
    confirmClose: jest.fn().mockResolvedValue(undefined),
  };
}

function openPosition(status: 'OPEN' | 'RECONCILIATION_PENDING' = 'OPEN') {
  return { ...TARGET, id: TARGET.tradeId, status };
}

describe('ClosePositionButton', () => {
  it('renders a small danger Close Position button for an OPEN position', () => {
    const controller = buildController();

    render(<ClosePositionButton position={openPosition()} controller={controller} />);

    const button = screen.getByRole('button', {
      name: 'Close BUY EURUSD position (0.1000 lot)',
    });
    expect(button).toHaveClass('btn--danger');
    expect(button).toHaveClass('btn--sm');
    expect(button).not.toBeDisabled();
  });

  it('renders a muted note instead of an active button for RECONCILIATION_PENDING', () => {
    const controller = buildController();

    render(
      <ClosePositionButton
        position={openPosition('RECONCILIATION_PENDING')}
        controller={controller}
      />,
    );

    expect(
      screen.getByText('Close unavailable — state being reconciled'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(controller.requestClose).not.toHaveBeenCalled();
  });

  it('asks the controller to confirm the exact position on click', () => {
    const controller = buildController();

    render(<ClosePositionButton position={openPosition()} controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /Close BUY EURUSD/ }));

    expect(controller.requestClose).toHaveBeenCalledTimes(1);
    expect(controller.requestClose).toHaveBeenCalledWith(TARGET);
  });

  it('shows the confirmation dialog for the target position with the exact blast radius', () => {
    const controller = buildController({ confirmTarget: TARGET });

    render(<ClosePositionButton position={openPosition()} controller={controller} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Close this position?')).toBeInTheDocument();
    expect(
      screen.getByText(/Close the BUY EURUSD position \(0\.1000 lot\) now\?/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /This closes only this position\. Other open positions and AI Trading are not affected\./,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close Position' }));
    expect(controller.confirmClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep Position Open' }));
    expect(controller.cancelClose).toHaveBeenCalledTimes(1);
  });

  it('does not open a dialog for a different position confirmation', () => {
    const controller = buildController({
      confirmTarget: { ...TARGET, tradeId: 'trade-other' },
    });

    render(<ClosePositionButton position={openPosition()} controller={controller} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables with a loading state while the position close is in flight', () => {
    const controller = buildController({ pending: true, confirmTarget: TARGET });

    render(<ClosePositionButton position={openPosition()} controller={controller} />);

    const button = screen.getByRole('button', { name: /Close BUY EURUSD/ });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Closing…');

    // The in-flight dialog keeps its guarded labels (ConfirmDialog pattern
    // shared with the emergency-stop flow).
    expect(screen.getByRole('button', { name: 'Closing…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Position' })).not.toBeInTheDocument();
  });
});
