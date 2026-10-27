let selectedTraderBrokerId: string | null = null;

/**
 * In-memory broker selection shared by the trader workspace data loaders.
 *
 * The AI Trading page can render while there is no active trading session, so
 * execution-history reads cannot rely on session authority alone to identify
 * the account whose money is being displayed. The terminal loader seeds this
 * context with the active-session broker or primary broker, while explicit
 * allocation reads update it when the user changes the broker selector.
 */
export function setSelectedTraderBrokerId(
  brokerConnectionId: string | null | undefined,
): void {
  selectedTraderBrokerId = brokerConnectionId?.trim() || null;
}

export function getSelectedTraderBrokerId(): string | null {
  return selectedTraderBrokerId;
}

/**
 * Reconcile terminal state without clobbering a valid explicit broker choice.
 * An active trading session always wins because execution authority is pinned
 * to that broker. Otherwise keep the current selection while it remains in the
 * loaded broker inventory, falling back to the primary broker only as needed.
 */
export function reconcileSelectedTraderBrokerId(input: {
  brokerIds: string[];
  sessionBrokerId?: string | null;
  primaryBrokerId?: string | null;
}): string | null {
  if (input.sessionBrokerId) {
    setSelectedTraderBrokerId(input.sessionBrokerId);
    return input.sessionBrokerId;
  }

  const current = getSelectedTraderBrokerId();
  if (current && input.brokerIds.includes(current)) {
    return current;
  }

  const fallback = input.primaryBrokerId ?? null;
  setSelectedTraderBrokerId(fallback);
  return fallback;
}
