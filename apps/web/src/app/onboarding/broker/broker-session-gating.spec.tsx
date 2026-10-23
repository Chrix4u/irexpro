import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnboardingBrokerPage from './page';
import BrokerOAuthCallbackClient from './callback/callback-client';
import { IREXPRO_BROKER_OAUTH_FLOW_KEY } from '@/lib/broker-oauth-flow';

const authState: { user: object | null; restoring: boolean } = {
  user: null,
  restoring: true,
};

const listSupportedBrokers = jest.fn();
const listBrokerConnections = jest.fn();
const listBrokerRegistry = jest.fn();
const completeBrokerOAuth = jest.fn();
const linkBrokerOAuth = jest.fn();


jest.mock('@/components/ui', () => {
  const Wrapper = ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>;
  const Button = ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button {...props}>{children}</button>
  );
  const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
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

jest.mock('@/components/notifications/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

jest.mock('@/context/auth-context', () => ({
  useAuth: () => ({
    user: authState.user,
    restoring: authState.restoring,
    logout: jest.fn(),
  }),
}));

jest.mock('@/lib/api', () => ({
  api: {
    listSupportedBrokers: (...args: unknown[]) => listSupportedBrokers(...args),
    listBrokerConnections: (...args: unknown[]) => listBrokerConnections(...args),
    listBrokerRegistry: (...args: unknown[]) => listBrokerRegistry(...args),
    completeBrokerOAuth: (...args: unknown[]) => completeBrokerOAuth(...args),
    linkBrokerOAuth: (...args: unknown[]) => linkBrokerOAuth(...args),
  },
}));

jest.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>{children}</a>
  );
  return MockLink;
});

describe('broker auth restoration gating', () => {
  beforeEach(() => {
    authState.user = null;
    authState.restoring = true;
    listSupportedBrokers.mockReset().mockResolvedValue([]);
    listBrokerConnections.mockReset().mockResolvedValue([]);
    listBrokerRegistry.mockReset().mockResolvedValue({ brokers: [] });
    completeBrokerOAuth.mockReset().mockResolvedValue({ flowId: 'flow-1', accounts: [] });
    linkBrokerOAuth.mockReset().mockResolvedValue({ brokerName: 'Spotware', accountId: '1234567' });
    sessionStorage.clear();
  });

  it('does not load protected broker data until auth restoration has completed', async () => {
    render(<OnboardingBrokerPage />);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listSupportedBrokers).not.toHaveBeenCalled();
    expect(listBrokerConnections).not.toHaveBeenCalled();
    expect(listBrokerRegistry).not.toHaveBeenCalled();
  });

  it('does not spend the cTrader authorization code while auth restoration is still running', async () => {
    sessionStorage.setItem(IREXPRO_BROKER_OAUTH_FLOW_KEY, 'flow-1');

    render(<BrokerOAuthCallbackClient code="authorization-code" />);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completeBrokerOAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(IREXPRO_BROKER_OAUTH_FLOW_KEY)).toBe('flow-1');
  });

  it('completes cTrader authorization once restoration is complete and the user is present', async () => {
    authState.user = { id: 'user-1' };
    authState.restoring = false;
    sessionStorage.setItem(IREXPRO_BROKER_OAUTH_FLOW_KEY, 'flow-1');

    render(<BrokerOAuthCallbackClient code="authorization-code" />);

    await waitFor(() => {
      expect(completeBrokerOAuth).toHaveBeenCalledWith({
        flowId: 'flow-1',
        code: 'authorization-code',
      });
    });
    expect(sessionStorage.getItem(IREXPRO_BROKER_OAUTH_FLOW_KEY)).toBe('flow-1');
  });

  it('automatically links the only discovered DEMO account after authorization', async () => {
    authState.user = { id: 'user-1' };
    authState.restoring = false;
    sessionStorage.setItem(IREXPRO_BROKER_OAUTH_FLOW_KEY, 'flow-1');
    completeBrokerOAuth.mockResolvedValue({
      flowId: 'flow-1',
      accounts: [
        {
          ctidTraderAccountId: '1234567',
          isLive: false,
          traderLogin: 987654,
          brokerTitleShort: 'Spotware',
        },
      ],
    });

    render(<BrokerOAuthCallbackClient code="authorization-code" />);

    await waitFor(() => {
      expect(linkBrokerOAuth).toHaveBeenCalledWith({
        flowId: 'flow-1',
        ctidTraderAccountId: '1234567',
        displayName: 'Spotware DEMO 1234567',
      });
    });
    await waitFor(() => {
      expect(sessionStorage.getItem(IREXPRO_BROKER_OAUTH_FLOW_KEY)).toBeNull();
    });
  });

});
