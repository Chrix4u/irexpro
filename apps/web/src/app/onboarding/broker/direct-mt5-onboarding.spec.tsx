import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnboardingBrokerPage from './page';

const listSupportedBrokers = jest.fn();
const listBrokerConnections = jest.fn();
const listBrokerRegistry = jest.fn();
const createBrokerConnection = jest.fn();
const createDirectMt5Pairing = jest.fn();
const getDirectMt5ConnectionHealth = jest.fn();
const revokeDirectMt5Connector = jest.fn();

jest.mock('@/components/ui', () => {
  const Wrapper = ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>;
  const Button = ({
    children,
    loading: _loading,
    variant: _variant,
    size: _size,
    ...props
  }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; size?: string }>) => (
    <button {...props}>{children}</button>
  );
  const Input = ({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  );
  return {
    DashboardShell: Wrapper,
    Card: Wrapper,
    Alert: Wrapper,
    Badge: Wrapper,
    EmptyState: Wrapper,
    Button,
    Input,
  };
});

jest.mock('@/components/notifications/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

jest.mock('@/context/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    restoring: false,
    logout: jest.fn(),
  }),
}));

jest.mock('@/lib/api', () => ({
  api: {
    listSupportedBrokers: (...args: unknown[]) => listSupportedBrokers(...args),
    listBrokerConnections: (...args: unknown[]) => listBrokerConnections(...args),
    listBrokerRegistry: (...args: unknown[]) => listBrokerRegistry(...args),
    createBrokerConnection: (...args: unknown[]) => createBrokerConnection(...args),
    createDirectMt5Pairing: (...args: unknown[]) => createDirectMt5Pairing(...args),
    getDirectMt5ConnectionHealth: (...args: unknown[]) => getDirectMt5ConnectionHealth(...args),
    revokeDirectMt5Connector: (...args: unknown[]) => revokeDirectMt5Connector(...args),
    testBrokerCredentials: jest.fn(),
    startBrokerOAuth: jest.fn(),
    connectBroker: jest.fn(),
    disconnectBroker: jest.fn(),
    request: jest.fn(),
  },
}));

jest.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() }),
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>{children}</a>
  );
  return MockLink;
});

const mt5RegistryEntry = {
  id: 'metatrader5',
  name: 'MetaTrader 5',
  description: 'MetaTrader 5',
  status: 'SUPPORTED',
  connectionRoutes: ['METATRADER'],
  capabilities: ['DEMO'],
  authenticationType: 'API_TOKEN',
  environments: ['DEMO'],
  regions: [],
  adapterAvailable: true,
  productionLiveVerification: { status: 'VERIFIED', verifiedAt: null, evidenceRef: null },
  connectionReadiness: { ready: true, code: 'READY', message: null },
};

describe('Direct MT5 onboarding', () => {
  beforeEach(() => {
    listSupportedBrokers.mockReset().mockResolvedValue([
      { brokerId: 'metatrader5', brokerName: 'MetaTrader 5', supportsDemo: true, supportsLive: true },
    ]);
    listBrokerConnections.mockReset().mockResolvedValue([]);
    listBrokerRegistry.mockReset().mockResolvedValue({ brokers: [mt5RegistryEntry] });
    createBrokerConnection.mockReset();
    createDirectMt5Pairing.mockReset();
    getDirectMt5ConnectionHealth.mockReset();
    revokeDirectMt5Connector.mockReset();
  });

  it('defaults MetaTrader 5 to the passwordless Direct Connector flow', async () => {
    const { container } = render(<OnboardingBrokerPage />);

    await waitFor(() => expect(container.querySelector('#broker-select')).not.toBeNull());

    expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.getByText(/never ask for your MT5 password/i)).not.toBeNull();
  });

  it('creates a DEMO connection without secrets and renders the server pairing code and READY health', async () => {
    createBrokerConnection.mockResolvedValue({ id: 'connection-1', brokerName: 'MetaTrader 5' });
    createDirectMt5Pairing.mockResolvedValue({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      pairingCode: 'ABCDEFGH23',
      expiresAt: '2026-10-25T21:00:00.000Z',
    });
    getDirectMt5ConnectionHealth.mockResolvedValue({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      state: 'ACTIVE',
      connected: true,
      executionReady: true,
      tradeAllowed: true,
      lastHeartbeatAt: '2026-10-25T20:59:58.000Z',
      heartbeatAgeMs: 2_000,
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      reason: 'READY',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '113392789' } });
    fireEvent.change(screen.getByLabelText('Display name (optional)'), { target: { value: 'My MT5 demo' } });
    fireEvent.click(screen.getByText('Create DEMO connection & pairing code'));

    await waitFor(() => {
      expect(createBrokerConnection).toHaveBeenCalledWith({
        brokerId: 'direct-mt5',
        accountType: 'DEMO',
        accountId: '113392789',
        displayName: 'My MT5 demo',
      });
      expect(createDirectMt5Pairing).toHaveBeenCalledWith('connection-1');
    });
    await waitFor(() => expect(screen.getByTestId('direct-mt5-pairing-code').textContent).toContain('ABCDEFGH23'));
    await waitFor(() => expect(screen.getByText('Ready')).not.toBeNull());
    expect(screen.getByText(/Broker server: Broker-Demo/)).not.toBeNull();
  });

  it('keeps MetaApi as an explicit optional path and restores credential inputs only when selected', async () => {
    const { container } = render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    fireEvent.click(screen.getByText('MT5 via MetaApi (optional)'));

    await waitFor(() => expect(container.querySelectorAll('input[type="password"]')).toHaveLength(2));
    expect(screen.getByText('Test credentials')).not.toBeNull();
    expect(screen.getByText(/separate MetaApi subscription/i)).not.toBeNull();
  });
});
