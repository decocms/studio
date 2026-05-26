import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TierTriggerPure } from "./tier-trigger";

describe("TierTriggerPure", () => {
  const subtitleFor = (tier: "fast" | "smart" | "thinking") =>
    ({ fast: "Haiku", smart: "Sonnet", thinking: "Opus" })[tier];

  it("closed pill shows tier name only", () => {
    const { getByRole, queryByText } = render(
      <TierTriggerPure
        tier="smart"
        subtitleFor={subtitleFor}
        onSelect={() => {}}
      />,
    );
    expect(getByRole("button", { name: /Smart/i })).toBeInTheDocument();
    expect(queryByText(/Sonnet/)).toBeNull();
  });

  it("popover shows three rows with subtitle from subtitleFor", () => {
    const { getByRole } = render(
      <TierTriggerPure
        tier="smart"
        subtitleFor={subtitleFor}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    expect(getByRole("menuitem", { name: /Fast/ }).textContent).toContain(
      "Haiku",
    );
    expect(getByRole("menuitem", { name: /Smart/ }).textContent).toContain(
      "Sonnet",
    );
    expect(getByRole("menuitem", { name: /Thinking/ }).textContent).toContain(
      "Opus",
    );
  });

  it("hides the subtitle line when subtitleFor returns null", () => {
    const { getByRole, getAllByRole } = render(
      <TierTriggerPure
        tier="smart"
        subtitleFor={() => null}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    expect(getAllByRole("menuitem")).toHaveLength(3);
  });

  it("calls onSelect and closes when a row is clicked", () => {
    const onSelect = mock(() => {});
    const { getByRole, queryByRole } = render(
      <TierTriggerPure
        tier="smart"
        subtitleFor={subtitleFor}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    fireEvent.click(getByRole("menuitem", { name: /Thinking/ }));
    expect(onSelect).toHaveBeenCalledWith("thinking");
    expect(queryByRole("menuitem")).toBeNull();
  });
});
