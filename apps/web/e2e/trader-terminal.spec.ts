import { test, expect } from "@playwright/test";
import {
  gotoAsAuthenticated,
  setupErrorCollectors,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertNoFailedRequests,
  assertNoExternalRequests,
  mockAuthUser,
  mockAuthTokens,
  mockBrokerConnections,
} from "./fixtures";

const ACTIVE_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const OPEN_TRADE_ID = "55555555-5555-4555-8555-555555555555";
const CLOSED_TRADE_ID = "66666666-6666-4666-8666-666666666666";

const emptyDecisionExplorerSnapshot = {
  generatedAt: "2026-08-28T22:30:00.000Z",
  decisions: [],
};

const mockOpenPosition = {
  id: OPEN_TRADE_ID,
  instrument: "EURUSD",
  direction: "BUY",
  lotSize: "0.1000",
  requestedEntryPrice: "1.10000000",
  fillPrice: "1.10010000",
  stopLoss: "1.09500000",
  takeProfit: "1.11000000",
  trailingStopPips: null,
  status: "OPEN",
  exitPrice: null,
  closeReason: null,
  openedAt: "2026-08-28T18:05:00.000Z",
  closedAt: null,
  createdAt: "2026-08-28T18:04:00.000Z",
  updatedAt: "2026-08-28T18:05:00.000Z",
};

const mockClosedExecution = {
  id: CLOSED_TRADE_ID,
  instrument: "GBPUSD",
  direction: "SELL",
  lotSize: "0.0500",
  requestedEntryPrice: "1.35000000",
  fillPrice: "1.34990000",
  stopLoss: "1.35500000",
  takeProfit: "1.34000000",
  trailingStopPips: null,
  status: "CLOSED",
  exitPrice: "1.34200000",
  closeReason: "TAKE_PROFIT_HIT",
  openedAt: "2026-08-28T15:00:00.000Z",
  closedAt: "2026-08-28T17:00:00.000Z",
  createdAt: "2026-08-28T14:59:00.000Z",
  updatedAt: "2026-08-28T17:00:00.000Z",
};

async function gotoTradeWithLiveStatusMocks(
  page: Parameters<typeof setupErrorCollectors>[0],
) {
  setupErrorCollectors(page);

  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.split("/api/v1/")[1] ?? "";

    const fulfill = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (apiPath === "auth/refresh") return fulfill(200, mockAuthTokens);
    if (apiPath === "auth/me") return fulfill(200, mockAuthUser);
    if (apiPath === "auth/logout")
      return fulfill(200, { message: "Logged out" });

    if (apiPath === "risk/status") {
      return fulfill(200, {
        killSwitchActive: false,
        brokerConnected: true,
        canTrade: true,
        limits: {
          maxDailyLossPercent: "5",
          maxDrawdownPercent: "10",
          maxOpenTrades: 3,
          maxPositionSizeLot: "1.00",
          allowedInstruments: "ALL",
          maxVolatilityScore: "7",
        },
      });
    }

    if (apiPath === "trading/sessions/active") {
      // TradingController returns TradingSessionResponseDto directly (or null),
      // never a legacy { session } envelope.
      return fulfill(200, {
        id: ACTIVE_SESSION_ID,
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: "PAPER_ONLY",
        authorityGeneration: 1,
        status: "ACTIVE",
        openingBalance: "10000.00",
        peakEquity: "10000.00",
        startedAt: "2026-08-28T18:00:00.000Z",
      });
    }

    if (apiPath === "broker/connections") {
      return fulfill(200, mockBrokerConnections);
    }

    if (apiPath === "execution/positions/open") {
      return fulfill(200, [mockOpenPosition]);
    }

    if (apiPath === "execution/trades/recent") {
      return fulfill(200, [mockOpenPosition, mockClosedExecution]);
    }

    return fulfill(200, {});
  });

  await page.goto("/trade");
  await expect(
    page.getByRole("heading", { level: 1, name: "AI Trading Workspace" }),
  ).toBeVisible();
}

test.describe("Trader terminal workspaces", () => {
  test("AI Decision Explorer retains the authoritative-data foundation", async ({
    page,
  }) => {
    await gotoAsAuthenticated(page, "/ai", {
      heading: /AI Decision Explorer/i,
    });

    await page.route("**/api/v1/ai/decisions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyDecisionExplorerSnapshot),
      }),
    );
    await page.getByRole("button", { name: "Refresh decisions" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "AI Decision Explorer" }),
    ).toBeVisible();
    await expect(
      page.getByText(/reports recorded evidence only/i),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Decision Timeline" }),
    ).toBeVisible();
    await expect(
      page.getByText("No persisted AI decisions yet", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/does not expose hidden model reasoning/i),
    ).toBeVisible();
    await expect(
      page.getByText(/unable to load persisted ai decision evidence/i),
    ).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test("AI Trading Workspace keeps execution primary and diagnostics optional", async ({ page }) => {
    await gotoTradeWithLiveStatusMocks(page);

    await expect(page.getByRole("switch", { name: "AI Auto" })).toBeVisible();
    await expect(page.getByText("AI allocation", { exact: true })).toBeVisible();

    const openPositions = page.getByRole("heading", { level: 2, name: "Open Positions (1)" }).locator("..");
    await expect(openPositions.getByText("EURUSD", { exact: true })).toBeVisible();
    await expect(openPositions.getByText(/BUY · 0.1000 lot/i)).toBeVisible();

    const recentExecutions = page.getByRole("heading", { level: 2, name: "Recent Executions" }).locator("..");
    await expect(recentExecutions.getByText("GBPUSD", { exact: true })).toBeVisible();
    await expect(recentExecutions.getByText("Take Profit Hit", { exact: true })).toBeVisible();

    const advanced = page.locator("details.cockpit-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await advanced.locator("summary").click();
    await expect(page.getByRole("heading", { level: 2, name: "Risk Engine" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Execution Authority" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Broker Diagnostics" })).toBeVisible();

    await expect(page.getByText(/server-authoritative broker, allocation, market and execution read models/i)).toBeVisible();
    await expect(page.getByText(/P&L is not fabricated/i)).toBeVisible();
    await expect(page.getByText("realisedPnl", { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test("desktop workspace navigation exposes only the essential product flow", async ({ page }) => {
    await gotoAsAuthenticated(page, "/trade", { heading: /AI Trading Workspace/i });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width <= 700) { test.skip(); return; }

    const nav = page.getByRole("navigation", { name: /primary workspace navigation/i });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "AI Auto Trader" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Live Account" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Broker Accounts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Market Intelligence" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Risk Limits" })).toHaveCount(0);
  });

  test("mobile bottom nav exposes AI Trader directly and keeps More focused on account tasks", async ({ page }) => {
    await gotoAsAuthenticated(page, "/trade", { heading: /AI Trading Workspace/i });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width > 700) { test.skip(); return; }

    const bottomItems = page.locator(".mobile-bottom-nav__item");
    await expect(bottomItems).toHaveCount(4);
    await expect(page.getByRole("link", { name: "AI Trader" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: /more navigation/i }).click();
    const sheet = page.locator("#mobile-more-sheet");
    await expect(sheet.getByRole("link", { name: "Broker Accounts" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Security" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Fees & Payments" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Strategy Lab" })).toHaveCount(0);
  });
});
