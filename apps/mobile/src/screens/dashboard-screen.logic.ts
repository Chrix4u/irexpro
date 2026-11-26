/** Presentation only: never grants execution authority. */
export function readinessPresentation(
  serverReady: boolean | undefined,
  serverBrokerConnected: boolean | undefined,
  transportConnected: boolean | null,
  checking: boolean,
) {
  if (checking) return { label: 'CHECKING', tone: 'neutral' } as const;
  if (serverReady === undefined || transportConnected === null) {
    return { label: 'UNVERIFIED', tone: 'warning' } as const;
  }
  if (serverBrokerConnected !== transportConnected) {
    return { label: 'REVIEW_REQUIRED', tone: 'warning' } as const;
  }
  if (serverReady && transportConnected) return { label: 'READY', tone: 'positive' } as const;
  return { label: 'SETUP_REQUIRED', tone: 'warning' } as const;
}
