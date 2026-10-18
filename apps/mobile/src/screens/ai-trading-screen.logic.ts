import type { BrokerConnectionView } from "@irexpro/types";
import {
  startExecutionModeForBroker,
  type AiStopPositionCloseState,
  type StopTradingSessionResponse,
  type TradingSessionView,
} from "@irexpro/types/execution";

export type AutomationStopPresentation = {
  tone: "success" | "warning";
  title: string;
  message: string;
};

export type MobileForexMarketSchedule = {
  paused: boolean;
  reason: "WEEKEND" | "ROLLOVER_LOW_LIQUIDITY" | null;
  nextEligibleScanAt: string;
};

type BrokerPreparationRequest = <T>(
  path: string,
  options?: { method?: "POST" | "GET" },
) => Promise<T>;

type DemoValidationStepView = {
  name: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  detail?: string;
};

type DemoValidationResultView = {
  overall: "PASS" | "FAIL";
  demoValidated: boolean;
  steps: DemoValidationStepView[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractForexMarketSchedule(value: unknown): MobileForexMarketSchedule | null {
  if (!isRecord(value) || !isRecord(value.marketSchedule)) return null;
  const schedule = value.marketSchedule;
  const reason = schedule.reason;
  if (
    typeof schedule.paused !== "boolean" ||
    (reason !== null && reason !== "WEEKEND" && reason !== "ROLLOVER_LOW_LIQUIDITY") ||
    typeof schedule.nextEligibleScanAt !== "string" ||
    !Number.isFinite(Date.parse(schedule.nextEligibleScanAt))
  ) {
    return null;
  }
  return {
    paused: schedule.paused,
    reason,
    nextEligibleScanAt: schedule.nextEligibleScanAt,
  };
}

export function isWeekendMarketClosed(
  schedule: MobileForexMarketSchedule | null,
): boolean {
  return schedule?.paused === true && schedule.reason === "WEEKEND";
}

export function formatMarketReopenCountdown(
  schedule: MobileForexMarketSchedule | null,
  nowMs: number,
): string {
  if (!schedule) return "Reopening shortly";
  const targetMs = Date.parse(schedule.nextEligibleScanAt);
  if (!Number.isFinite(targetMs)) return "Reopening shortly";
  const remainingSeconds = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (remainingSeconds <= 0) return "Reopening shortly";
  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor((remainingSeconds % 86400) / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const hh = hours > 0 || days > 0 ? `${hours}h ` : "";
  const dd = days > 0 ? `${days}d ` : "";
  return `${dd}${hh}${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function parseDemoValidation(value: unknown): DemoValidationResultView {
  if (!isRecord(value) || (value.overall !== "PASS" && value.overall !== "FAIL") ||
      typeof value.demoValidated !== "boolean" || !Array.isArray(value.steps)) {
    throw new Error("DEMO validation response contract mismatch");
  }
  const steps: DemoValidationStepView[] = [];
  for (const raw of value.steps) {
    if (!isRecord(raw) || typeof raw.name !== "string" ||
        (raw.status !== "PASS" && raw.status !== "FAIL" && raw.status !== "SKIPPED") ||
        (raw.detail !== undefined && typeof raw.detail !== "string")) {
      throw new Error("DEMO validation response contract mismatch");
    }
    steps.push({
      name: raw.name,
      status: raw.status,
      ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    });
  }
  if (value.overall === "PASS" && value.demoValidated !== true) {
    throw new Error("DEMO validation response contract mismatch");
  }
  return { overall: value.overall, demoValidated: value.demoValidated, steps };
}

export async function prepareBrokerForAutomationStart(
  broker: Pick<BrokerConnectionView, "id" | "brokerId" | "accountType" | "authorizationStatus" | "demoValidated">,
  request: BrokerPreparationRequest,
): Promise<{ ready: true } | { ready: false; message: string }> {
  if (
    broker.accountType !== "DEMO" ||
    broker.brokerId === "paper-broker" ||
    broker.authorizationStatus === "ACTIVE"
  ) {
    return { ready: true };
  }

  if (!broker.demoValidated) {
    const validation = parseDemoValidation(
      await request<unknown>(
        `/broker/connections/${encodeURIComponent(broker.id)}/validate-demo`,
        { method: "POST" },
      ),
    );
    if (validation.overall !== "PASS" || !validation.demoValidated) {
      const failed = validation.steps.find((step) => step.status === "FAIL");
      const detail = failed?.detail?.trim();
      return {
        ready: false,
        message: failed
          ? detail
            ? `DEMO validation failed at ${failed.name}: ${detail}`
            : `DEMO validation failed at ${failed.name}.`
          : "DEMO validation failed. Check the broker connection and try again.",
      };
    }
  }

  await request<void>(
    `/broker/connections/${encodeURIComponent(broker.id)}/enable-demo-trading`,
    { method: "POST" },
  );
  return { ready: true };
}

export function isAutomationRunning(
  session: TradingSessionView | null,
): boolean {
  return session?.status === "ACTIVE" || session?.status === "PAUSED";
}

export function isBrokerExecutionReady(
  connection: BrokerConnectionView,
): boolean {
  if (connection.status !== "CONNECTED") return false;

  // The internal paper broker is database-authoritatively PAPER_ONLY and
  // cannot create LIVE exposure. Backend session start gates it on connected
  // transport + fresh health, not ACTIVE external-provider authorization.
  if (connection.brokerId === "paper-broker") return true;

  // External DEMO may still need the server's validate-demo/enable-demo
  // preparation sequence. AUTHORIZED/READY are therefore preparable states;
  // the backend remains the final execution authority. LIVE stays ACTIVE-only.
  if (connection.accountType === "DEMO") {
    return (
      connection.authorizationStatus === "AUTHORIZED" ||
      connection.authorizationStatus === "READY" ||
      connection.authorizationStatus === "ACTIVE"
    );
  }

  return connection.authorizationStatus === "ACTIVE";
}

export function startExecutionModeFor(
  connection: BrokerConnectionView,
): "PAPER_ONLY" | "FULL_AUTO" {
  return startExecutionModeForBroker(connection);
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

  if (requestedId) {
    const requested = connections.find(
      (connection) => connection.id === requestedId,
    );
    if (requested?.status === "CONNECTED") {
      return requestedId;
    }
  }

  const fullyActive = connections.find(
    (connection) =>
      connection.status === "CONNECTED" &&
      (connection.brokerId === "paper-broker" ||
        connection.authorizationStatus === "ACTIVE"),
  );
  if (fullyActive) return fullyActive.id;

  const executionReady = connections.find(isBrokerExecutionReady);
  if (executionReady) return executionReady.id;

  const connected = connections.find(
    (connection) => connection.status === "CONNECTED",
  );
  if (connected) return connected.id;

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
