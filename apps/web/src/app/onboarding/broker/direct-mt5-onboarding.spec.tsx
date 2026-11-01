import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnboardingBrokerPage from './page';

const listSupportedBrokers = jest.fn();
const listBrokerConnections = jest.fn();
const listBrokerRegistry = jest.fn();
const createBrokerConnection = jest.fn();
const provisionHostedMt5 = jest.fn();
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
    provisionHostedMt5: (...args: unknown[]) => provisionHostedMt5(...args),
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
  name: 'MetaTrader 5',
  description: 'Native MT5 execution',
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
  hostedMt5Readiness: { ready: true, code: 'READY', message: null },
};

const legacyMetaApiRegistryEntry = {
  id: 'metatrader5',
  name: 'MetaTrader 5 — Legacy MetaAPI',
  description: 'Legacy provider',
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

describe('MetaTrader 5 onboarding', () => {
  beforeEach(() => {
    listSupportedBrokers.mockReset().mockResolvedValue([
      { brokerId: 'direct-mt5', brokerName: 'MetaTrader 5', supportsDemo: true, supportsLive: true },
    ]);
    listBrokerConnections.mockReset().mockResolvedValue([]);
    listBrokerRegistry.mockReset().mockResolvedValue({
      brokers: [directMt5RegistryEntry, legacyMetaApiRegistryEntry],
    });
    createBrokerConnection.mockReset();
    provisionHostedMt5.mockReset();
    createDirectMt5Pairing.mockReset();
    getDirectMt5ConnectionHealth.mockReset().mockResolvedValue({
      connectorId: 'connector-hosted',
      brokerConnectionId: 'connection-hosted',
      hostMode: 'IREXPRO_HOSTED',
      state: 'PAIRING',
      connected: false,
      executionReady: false,
      tradeAllowed: false,
      lastHeartbeatAt: null,
      heartbeatAgeMs: null,
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      reason: 'HEARTBEAT_MISSING',
    });
    revokeDirectMt5Connector.mockReset();
  });

  it('defaults MT5 to iRexPro Hosted and makes clear the customer computer can be off', async () => {
    const { container } = render(<OnboardingBrokerPage />);

    await waitFor(() => expect(container.querySelector('#broker-select')).not.toBeNull());

    expect(screen.getByRole('button', { name: /iRexPro Hosted — Recommended/i })).not.toBeNull();
    expect(screen.getByText(/your computer can be switched off/i)).not.toBeNull();
    expect(screen.getByLabelText('MT5 trading password')).not.toBeNull();
    expect(screen.getByLabelText('Broker server')).not.toBeNull();
    expect(screen.queryByText(/MetaApi/i)).toBeNull();
  });

  it('fails closed to the passwordless Direct Connector when hosted workers are not enabled', async () => {
    listBrokerRegistry.mockResolvedValue({
      brokers: [
        {
          ...directMt5RegistryEntry,
          hostedMt5Readiness: {
            ready: false,
            code: 'HOSTED_MT5_NOT_READY',
            message: 'Hosted MT5 is not enabled on this server yet.',
          },
        },
        legacyMetaApiRegistryEntry,
      ],
    });

    render(<OnboardingBrokerPage />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Direct Connector — Passwordless/i }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(screen.queryByLabelText('MT5 trading password')).toBeNull();
    const hostedButton = screen.getByRole('button', { name: /iRexPro Hosted/i }) as HTMLButtonElement;
    expect(hostedButton.disabled).toBe(true);
    expect(screen.getByText(/not enabled on this server yet/i)).not.toBeNull();
  });

  it('creates an encrypted hosted DEMO connection, provisions it, and clears the password field', async () => {
    createBrokerConnection.mockResolvedValue({ id: 'connection-hosted', brokerName: 'MetaTrader 5' });
    provisionHostedMt5.mockResolvedValue({
      brokerConnectionId: 'connection-hosted',
      connectorId: 'connector-hosted',
      hostMode: 'IREXPRO_HOSTED',
      state: 'PAIRING',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByLabelText('MT5 trading password')).not.toBeNull());

    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '113392789' } });
    fireEvent.change(screen.getByLabelText('Broker server'), { target: { value: 'Broker-Demo' } });
    fireEvent.change(screen.getByLabelText('MT5 trading password'), { target: { value: 'demo-password' } });
    fireEvent.change(screen.getByLabelText('Display name (optional)'), { target: { value: 'My hosted MT5' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect MT5 on iRexPro — DEMO/i }));

    await waitFor(() => expect(createBrokerConnection).toHaveBeenCalledWith({
      brokerId: 'direct-mt5',
      accountType: 'DEMO',
      accountId: '113392789',
      apiSecret: 'demo-password',
      displayName: 'My hosted MT5',
      additionalParams: {
        brokerServer: 'Broker-Demo',
        connectionMethod: 'IREXPRO_HOSTED',
      },
    }));
    expect(provisionHostedMt5).toHaveBeenCalledWith('connection-hosted');
    await waitFor(() => expect(screen.queryByLabelText('MT5 trading password')).toBeNull());
  });

  it('keeps hosted LIVE unavailable during the DEMO pilot even if Direct MT5 itself is certified', async () => {
    listBrokerRegistry.mockResolvedValue({
      brokers: [{
        ...directMt5RegistryEntry,
        productionLiveVerification: {
          status: 'VERIFIED',
          verifiedAt: '2026-11-01T12:00:00.000Z',
          evidenceRef: 'direct-live.json',
          certifiedVia: 'HARNESS_CERTIFIED',
          certificationRunRef: 'direct-live.json',
        },
        certificationState: 'CERTIFIED',
      }, legacyMetaApiRegistryEntry],
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByLabelText('MT5 environment')).not.toBeNull());

    const environment = screen.getByLabelText('MT5 environment') as HTMLSelectElement;
    const live = Array.from(environment.options).find((option) => option.value === 'LIVE');
    expect(live?.disabled).toBe(true);
    expect(screen.getByText(/Hosted LIVE is locked until hosted execution certification/i)).not.toBeNull();
  });

  it('keeps the passwordless Direct Connector as an explicit fallback and pairs a personal PC', async () => {
    createBrokerConnection.mockResolvedValue({ id: 'connection-direct', brokerName: 'MetaTrader 5' });
    createDirectMt5Pairing.mockResolvedValue({
      connectorId: 'connector-direct',
      brokerConnectionId: 'connection-direct',
      hostMode: 'PERSONAL_PC',
      pairingCode: 'ABCDEFGH23',
      expiresAt: '2026-11-01T18:00:00.000Z',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Direct Connector — Passwordless/i })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Direct Connector — Passwordless/i }));

    expect(screen.queryByLabelText('MT5 trading password')).toBeNull();
    expect(screen.getByText(/we never ask for your MT5 password/i)).not.toBeNull();
    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '113392789' } });
    fireEvent.click(screen.getByRole('button', { name: /Create DEMO connection & pairing code/i }));

    await waitFor(() => {
      expect(createBrokerConnection).toHaveBeenCalledWith({
        brokerId: 'direct-mt5',
        accountType: 'DEMO',
        accountId: '113392789',
        displayName: undefined,
      });
      expect(createDirectMt5Pairing).toHaveBeenCalledWith('connection-direct', 'PERSONAL_PC');
    });
  });

  it('supports the passwordless Direct Connector on an always-on Windows VPS', async () => {
    createBrokerConnection.mockResolvedValue({ id: 'connection-vps', brokerName: 'MetaTrader 5' });
    createDirectMt5Pairing.mockResolvedValue({
      connectorId: 'connector-vps',
      brokerConnectionId: 'connection-vps',
      hostMode: 'WINDOWS_VPS',
      pairingCode: 'ABCDEFGH23',
      expiresAt: '2026-11-01T18:00:00.000Z',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Direct Connector — Passwordless/i })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Direct Connector — Passwordless/i }));
    fireEvent.click(screen.getByRole('button', { name: /Always-on Windows VPS/i }));
    expect(screen.getByText(/personal PC can be switched off/i)).not.toBeNull();

    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '113392789' } });
    fireEvent.click(screen.getByRole('button', { name: /Create DEMO connection & pairing code/i }));
    await waitFor(() => expect(createDirectMt5Pairing).toHaveBeenCalledWith('connection-vps', 'WINDOWS_VPS'));
  });

  it('renders hosted health as iRexPro hosted execution after provisioning', async () => {
    createBrokerConnection.mockResolvedValue({ id: 'connection-hosted', brokerName: 'MetaTrader 5' });
    provisionHostedMt5.mockResolvedValue({
      brokerConnectionId: 'connection-hosted', connectorId: 'connector-hosted', hostMode: 'IREXPRO_HOSTED', state: 'PAIRING',
    });

    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByLabelText('MT5 account login')).not.toBeNull());
    fireEvent.change(screen.getByLabelText('MT5 account login'), { target: { value: '113392789' } });
    fireEvent.change(screen.getByLabelText('Broker server'), { target: { value: 'Broker-Demo' } });
    fireEvent.change(screen.getByLabelText('MT5 trading password'), { target: { value: 'demo-password' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect MT5 on iRexPro — DEMO/i }));

    await waitFor(() => expect(screen.getByText(/Execution host:/).parentElement?.textContent).toContain('iRexPro hosted execution'));
  });

  it('does not offer legacy MetaAPI as a new broker connection route', async () => {
    const { container } = render(<OnboardingBrokerPage />);
    await waitFor(() => expect(container.querySelector('#broker-select')).not.toBeNull());

    const options = Array.from((container.querySelector('#broker-select') as HTMLSelectElement).options);
    expect(options.map((option) => option.value)).not.toContain('metatrader5');
    expect(screen.queryByText(/MetaApi/i)).toBeNull();
  });

  it('explains that the Windows connector is required only for Direct mode, not Hosted mode', async () => {
    render(<OnboardingBrokerPage />);
    await waitFor(() => expect(screen.getByText(/No Windows connector is required on your own computer/i)).not.toBeNull());
    expect(screen.getByText(/phone or web browser can be closed/i)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Direct Connector — Passwordless/i }));
    expect(screen.getByRole('link', { name: /Download Windows connector/i })).not.toBeNull();
  });
});
