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

jest.mock('@/hooks/useNotification', () => {
  const notification = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };
  return { useNotification: () => notification };
});

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>{children}</a>
  );
  return MockLink;
});


const directMt5RegistryEntry = {
  id: 'direct-mt5',
  name: 'MetaTrader 5 — Direct Terminal',
  description: 'Native Direct MT5 connector',
  status: 'BETA',
  connectionRoutes: ['METATRADER'],
  capabilities: ['DEMO', 'LIVE', 'METATRADER'],
  authenticationType: 'SESSION_AUTH',
  environments: ['DEMO', 'LIVE'],
  regions: [],
  adapterAvailable: true,
  productionLiveVerification: {
    status: 'UNVERIFIED', verifiedAt: null, evidenceRef: null, certifiedVia: null, certificationRunRef: null,
  },
  certificationState: 'NOT_CERTIFIED',
  connectionReadiness: { ready: true, code: 'READY', message: null },
};

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
    listBrokerRegistry.mockReset().mockResolvedValue({ brokers: [directMt5RegistryEntry, mt5RegistryEntry] });
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

  it('offers the durable Android phone app separately from the Windows MT5 execution bridge', async () => {
    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    const android = screen.getByRole('link', { name: /Download iRexPro Android preview/i });
    expect(android.getAttribute('href')).toContain(
      'releases/download/irexpro-mobile-v0.1.5-preview.1/iRexPro-Android-Preview.apk',
    );
    expect(screen.getByText(/phone app is your iRexPro control surface/i)).not.toBeNull();
    expect(screen.getByText(/Windows connector is still required as the MT5 execution bridge/i)).not.toBeNull();

    const windows = screen.getByRole('link', { name: /Download Windows connector/i });
    expect(windows.getAttribute('href')).toContain('mt5-connector-v0.2.0/iRexPro-MT5-Connector-Setup.exe');
  });

  it('shows the Windows installer and keeps LIVE visibly certification-locked', async () => {
    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    const download = screen.getByRole('link', { name: /Download Windows connector/i });
    expect(download.getAttribute('href')).toContain('mt5-connector-v0.2.0/iRexPro-MT5-Connector-Setup.exe');
    expect(screen.getByText(/protocol v2/i)).not.toBeNull();
    expect(screen.getByText(/re-pair/i)).not.toBeNull();

    const environment = screen.getByLabelText('MT5 environment') as HTMLSelectElement;
    const live = Array.from(environment.options).find((option) => option.value === 'LIVE');
    expect(live?.disabled).toBe(true);
    expect(screen.getByText(/LIVE certification pending/i)).not.toBeNull();
  });

  it('unlocks LIVE pairing only when the server registry reports current CERTIFIED evidence', async () => {
    listBrokerRegistry.mockResolvedValue({
      brokers: [
        {
          ...directMt5RegistryEntry,
          productionLiveVerification: {
            status: 'VERIFIED',
            verifiedAt: '2026-10-31T12:00:00.000Z',
            evidenceRef: 'live-certification-direct-mt5-run.json',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: 'live-certification-direct-mt5-run.json',
          },
          certificationState: 'CERTIFIED',
        },
        mt5RegistryEntry,
      ],
    });
    createBrokerConnection.mockResolvedValue({ id: 'connection-live', brokerName: 'MetaTrader 5 — Direct Terminal' });
    createDirectMt5Pairing.mockResolvedValue({
      connectorId: 'connector-live', brokerConnectionId: 'connection-live', pairingCode: 'ABCDEFGH23',
      expiresAt: '2026-10-31T12:10:00.000Z',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByLabelText('MT5 environment')).not.toBeNull());
    const environment = screen.getByLabelText('MT5 environment') as HTMLSelectElement;
    const live = Array.from(environment.options).find((option) => option.value === 'LIVE');
    expect(live?.disabled).toBe(false);

    fireEvent.change(environment, { target: { value: 'LIVE' } });
    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '543210' } });
    fireEvent.click(screen.getByText('Create LIVE connection & pairing code'));

    await waitFor(() => expect(createBrokerConnection).toHaveBeenCalledWith(expect.objectContaining({
      brokerId: 'direct-mt5', accountType: 'LIVE', accountId: '543210',
    })));
  });

  it('makes phone and web the primary Direct MT5 control surface and shows both Windows bridge choices', async () => {
    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    expect(screen.getByText(/Connect from any device/i)).not.toBeNull();
    expect(screen.getByText(/phone or web portal/i)).not.toBeNull();
    expect(screen.getByText(/Windows PC or VPS is only the MT5 execution bridge/i)).not.toBeNull();
    expect(screen.getByRole('button', { name: /I already have MT5 running on Windows/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /I need a Windows PC\/VPS for MT5/i })).not.toBeNull();
  });

  it('shows Windows or VPS setup guidance without creating a broker connection', async () => {
    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /I need a Windows PC\/VPS for MT5/i }));

    expect(screen.getByText(/Set up the MT5 execution bridge/i)).not.toBeNull();
    expect(screen.getByText(/Windows 10\/11 PC or Windows VPS/i)).not.toBeNull();
    expect(screen.getByText(/keep that Windows machine or VPS online/i)).not.toBeNull();
    expect(screen.queryByLabelText('MT5 account login')).toBeNull();
    expect(screen.queryByText('Create DEMO connection & pairing code')).toBeNull();
    expect(createBrokerConnection).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Download Windows connector/i })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /I already have MT5 running on Windows/i }));
    expect(screen.getByLabelText('MT5 account login')).not.toBeNull();
    expect(screen.getByText('Create DEMO connection & pairing code')).not.toBeNull();
  });

  it('keeps MetaApi as an explicit optional path and restores credential inputs only when selected', async () => {
    const { container } = render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/Direct Connector \(recommended\)/i)).not.toBeNull());

    fireEvent.click(screen.getByText('MT5 via MetaApi (optional)'));

    await waitFor(() => expect((container.querySelector('#broker-select') as HTMLSelectElement).value).toBe('metatrader5'));
    await waitFor(() => expect(container.querySelectorAll('input[type="password"]')).toHaveLength(2));
    expect(screen.getByText('Test credentials')).not.toBeNull();
    expect(screen.getByText(/separate MetaApi subscription/i)).not.toBeNull();
  });
});
