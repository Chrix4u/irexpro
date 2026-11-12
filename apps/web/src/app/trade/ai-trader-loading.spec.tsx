import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AiTraderLoading } from "./ai-trader-loading";

describe("AI Trader loading skeleton", () => {
  it("shows animated placeholders instead of unverified zeroes or dashes", () => {
    const { container } = render(<AiTraderLoading />);

    expect(screen.getByTestId("ai-trader-loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Preparing workspace…")).toBeInTheDocument();
    for (const label of ["Equity", "AI Allocation", "24h Net P&L", "Open P&L"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".ai-loading-kpi")).toHaveLength(4);
    expect(container.querySelectorAll(".ai-loading-shimmer").length).toBeGreaterThan(7);
    expect(container.querySelectorAll(".ai-kpi-card__value")).toHaveLength(0);
  });
});
