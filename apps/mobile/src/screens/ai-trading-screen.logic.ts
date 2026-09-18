import type { BrokerConnectionView } from "@irexpro/types";
import type {
  AiStopPositionCloseState,
  StopTradingSessionResponse,
  TradingSessionView,
} from "@irexpro/types/execution";

export type AutomationStopPresentation = {
  tone: "success" | "warning";
  title: string;
  message: string;
};

export function isAutomationRunning(
  session: TradingSessionView | null,
): boolean {
  return session?.status === "ACTIVE" || session?.status === "PAUSED";
}

export function isBrokerExecutionReady(
  connection: BrokerConnectionView,
): boolean {
  return (
    connection.status === "CONNECTED" &&
    connection.authorizationStatus === "ACTIVE"
  );
}

export function startExecutionModeFor(
  connection: BrokerConnectionView,
): "PAPER_ONLY" | "FULL_AUTO" {
  return connection.accountType === "LIVE" ? "FULL_AUTO" : "PAPER_ONLY";
}

/**
 * The active session owns broker selection while automation authority exists.
 * This prevents another account from inheriting a misleading global RUNNING
 * state in the mobile UI.
 */
export function pinnedBrokerId(
  connections: readonly BrokerConnectionView[],
  session: TradingSessionView | null,
  requestedId: string | null,
): string | null {
  if (session) return session.brokerConnectionId;

  if (
    requestedId &&
    connections.some((connection) => connection.id === requestedId)
  ) {
    return requestedId;
  }

  return connections[0]?.id ?? null;
}

export function describeStopSummary(
  result: StopTradingSessionResponse,
): AutomationStopPresentation {
  const summary = result.positionCloseSummary;

  if (summary.state === "COMPLETE") {
    if (summary.closedCount === 0) {
      return {
        tone: "success",
        title: "AI Trading stopped",
        message: "No AI-opened positions were open.",
      };
    }

    return {
      tone: "success",
      title: "AI Trading stopped",
      message:
        summary.closedCount +
        " AI position" +
        (summary.closedCount === 1 ? "" : "s") +
        " confirmed closed.",
    };
  }

  if (summary.state === "PARTIAL") {
    return {
      tone: "warning",
      title: "AI Trading stopped — follow-up required",
      message:
        summary.closedCount +
        " of " +
        (summary.targetCount ?? "the") +
        " AI positions were confirmed closed; " +
        (summary.unresolvedCount ?? "some") +
        " require follow-up in Positions & Activity.",
    };
  }

  return {
    tone: "warning",
    title: "AI Trading stopped — closure unverified",
    message:
      "Position closure could not be verified. Check Positions & Activity now.",
  };
}

export function stopStateLabel(state: AiStopPositionCloseState): string {
  if (state === "COMPLETE") return "Closed";
  if (state === "PARTIAL") return "Follow-up";
  return "Unverified";
}
