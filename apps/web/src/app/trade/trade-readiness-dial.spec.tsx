import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { TradeReadinessDial } from "./trade-readiness-dial";

describe("TradeReadinessDial", () => {
  it("renders all six scale labels and four ordered color arcs", () => {
    const { container } = render(<TradeReadinessDial score={57} />);
    expect([...container.querySelectorAll("svg text")].map((node) => node.textContent))
      .toEqual(["0", "20", "40", "60", "80", "100"]);
    expect([...container.querySelectorAll("svg path[stroke]")].map((node) => node.getAttribute("stroke")))
      .toEqual(["#ef4444", "#f97316", "#eab308", "#22c55e"]);
  });
  it("tracks real score changes through the whole semicircle", () => {
    const { container, rerender } = render(<TradeReadinessDial score={0} />);
    const needle = () => container.querySelector(".ai-readiness__dial-needle");
    expect(needle()).toHaveStyle({ transform: "rotate(-180deg)" });
    rerender(<TradeReadinessDial score={50} />);
    expect(needle()).toHaveStyle({ transform: "rotate(-90deg)" });
    rerender(<TradeReadinessDial score={100} />);
    expect(needle()).toHaveStyle({ transform: "rotate(0deg)" });
  });
  it("bounds finite values and never invents a pointer for an invalid score", () => {
    const { container, rerender } = render(<TradeReadinessDial score={150} />);
    expect(container.querySelector(".ai-readiness__dial-needle")).toHaveStyle({ transform: "rotate(0deg)" });
    rerender(<TradeReadinessDial score={Number.NaN} />);
    expect(container.querySelector(".ai-readiness__dial-needle")).not.toBeInTheDocument();
  });
});
