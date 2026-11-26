import type { TraderTerminalStatus } from "./trader-terminal-status";

const storageKey = (userId: string) => `irexpro:trader-broker-preference:v1:${userId}`;

/** Browser-local display preference only. Never stores credentials or authority. */
export function readBrokerPreference(userId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(userId)) || null;
  } catch {
    return null;
  }
}

export function rememberBrokerPreference(userId: string, brokerId: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), brokerId);
  } catch {
    // The current page still retains the user's explicit selection in memory.
  }
}

type AccountSelectionStatus = Pick<
  TraderTerminalStatus,
  "sessionStateKnown" | "session" | "sessionBroker" | "brokers"
>;

/** A session-bound account always wins; preferences cannot change authority. */
export function resolveWorkspaceBrokerId(
  status: AccountSelectionStatus,
  preferredId: string | null,
): string {
  if (status.sessionBroker) return status.sessionBroker.id;
  if (status.session) return "";
  if (preferredId !== null) {
    return status.brokers.some((broker) => broker.id === preferredId)
      ? preferredId
      : "";
  }
  // Never implicitly select a LIVE account on a fresh browser or profile.
  return (
    status.brokers.find(
      (broker) => broker.accountType !== "LIVE" && broker.status === "CONNECTED",
    )?.id ?? ""
  );
}
