import {
  isBrokerConnectionRuntimeReady,
  type BrokerRegistryEntry,
} from './broker-registry';

const entry = (
  readiness?: BrokerRegistryEntry['connectionReadiness'],
): Pick<BrokerRegistryEntry, 'connectionReadiness'> => ({
  connectionReadiness: readiness,
});

describe('isBrokerConnectionRuntimeReady', () => {
  it('blocks an explicitly unready broker runtime', () => {
    expect(
      isBrokerConnectionRuntimeReady(
        entry({
          ready: false,
          code: 'PLATFORM_CREDENTIALS_REQUIRED',
          message: 'Platform credentials are required.',
        }),
      ),
    ).toBe(false);
  });

  it('allows an explicitly ready broker runtime', () => {
    expect(
      isBrokerConnectionRuntimeReady(
        entry({ ready: true, code: 'READY', message: null }),
      ),
    ).toBe(true);
  });

  it('keeps older known payloads without readiness metadata backward-compatible', () => {
    expect(isBrokerConnectionRuntimeReady(entry())).toBe(true);
  });

  it('fails closed when the broker registry entry itself is missing', () => {
    expect(isBrokerConnectionRuntimeReady(null)).toBe(false);
    expect(isBrokerConnectionRuntimeReady(undefined)).toBe(false);
  });
});
