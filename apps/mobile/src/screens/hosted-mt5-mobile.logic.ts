/**
 * Hosted MT5 native mobile onboarding contract.
 *
 * The iRexPro Android/iOS app is a CONTROL PANEL, not the MT5 trading terminal.
 * Server readiness is authoritative: do not create or provision an account
 * unless a real iRexPro-owned Windows worker currently reports capacity.
 * The hosted pilot is DEMO-only; never infer LIVE access from a broker label.
 */
import type {
  BrokerRegistryEntry,
  CreateBrokerConnectionRequest,
  DirectMt5ConnectionHealthView,
} from "@irexpro/types";
import { mobileConnectionReadiness, statusPresentation } from "./broker-screen.logic";

export interface HostedMt5MobileAvailability {
  ready: boolean;
  message: string;
}

/** Explicit readiness is required; missing registry data fails closed. */
export function hostedMt5MobileAvailability(
  entry: BrokerRegistryEntry,
): HostedMt5MobileAvailability {
  if (entry.id !== "direct-mt5") {
    return { ready: false, message: "This is not the iRexPro Direct MT5 provider." };
  }
  if (!entry.adapterAvailable || !statusPresentation(entry.status).connectable) {
    return { ready: false, message: "The MT5 broker adapter is unavailable." };
  }
  if (!entry.environments.includes("DEMO")) {
    return { ready: false, message: "Hosted MT5 requires a supported DEMO account." };
  }
  const channel = mobileConnectionReadiness(entry);
  if (channel?.ready === false) {
    return {
      ready: false,
      message: channel.message || "MT5 mobile onboarding is not available.",
    };
  }
  if (entry.hostedMt5Readiness?.ready !== true) {
    return {
      ready: false,
      message: entry.hostedMt5Readiness?.message ||
        "iRexPro's hosted Windows MT5 worker is not online and ready.",
    };
  }
  return {
    ready: true,
    message: "iRexPro-hosted MT5 DEMO setup is available. No personal computer is required.",
  };
}

/**
 * Construct the existing encrypted server-side broker credential request.
 * No secret or login is persisted on the phone or added to the URL.
 */
export function buildHostedMt5MobileRequest(
  entry: BrokerRegistryEntry,
  input: {
    accountLogin: string;
    brokerServer: string;
    tradingPassword: string;
    displayName?: string;
  },
): CreateBrokerConnectionRequest | { error: string } {
  const availability = hostedMt5MobileAvailability(entry);
  if (!availability.ready) return { error: availability.message };

  const accountLogin = input.accountLogin.trim();
  const brokerServer = input.brokerServer.trim();
  if (!/^[0-9]{1,20}$/.test(accountLogin)) {
    return { error: "Enter the numeric MT5 login shown in your broker account." };
  }
  if (!brokerServer || brokerServer.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(brokerServer)) {
    return { error: "Enter the exact broker MT5 server name." };
  }
  if (!input.tradingPassword || input.tradingPassword.trim().length === 0) {
    return { error: "Enter the MT5 trading password, not the investor password." };
  }
  const displayName = input.displayName?.trim();
  if (displayName && displayName.length > 100) {
    return { error: "Display name is too long." };
  }
  return {
    brokerId: "direct-mt5",
    accountType: "DEMO",
    accountId: accountLogin,
    apiSecret: input.tradingPassword,
    ...(displayName ? { displayName } : {}),
    additionalParams: {
      brokerServer,
      connectionMethod: "IREXPRO_HOSTED",
    },
  };
}

/**
 * Never use the persisted BrokerConnection CONNECTED flag to claim that the
 * actual terminal is live. A fresh broker-identity heartbeat is required.
 */
export function hostedMt5MobileStatus(
  health: DirectMt5ConnectionHealthView | null | undefined,
): { tone: "ready" | "waiting" | "offline"; title: string; detail: string } {
  if (!health) {
    return { tone: "waiting", title: "Checking MT5 terminal",
      detail: "Waiting for a verified connector heartbeat." };
  }
  if (health.hostMode !== "IREXPRO_HOSTED") {
    return { tone: "offline", title: "Personal or external connector",
      detail: "This MT5 connection is not hosted by iRexPro." };
  }
  if (health.state === "REVOKED" || health.state === "SUSPENDED") {
    return { tone: "offline", title: "Hosted connector inactive",
      detail: "This session needs operator review before new trades." };
  }
  if (health.executionReady && health.connected && health.tradeAllowed &&
      health.reason === "READY" && Boolean(health.lastHeartbeatAt) &&
      typeof health.heartbeatAgeMs === "number" &&
      health.heartbeatAgeMs >= 0 && health.heartbeatAgeMs <= 15_000) {
    return { tone: "ready", title: "Hosted MT5 terminal ready",
      detail: "Broker heartbeat verified. Trading remains subject to server risk gates." };
  }
  return { tone: "waiting", title: "Hosted MT5 not execution-ready",
    detail: "Terminal setup, broker authentication or heartbeat verification is pending (" +
      health.reason.replace(/_/g, " ").toLowerCase() + ")." };
}
