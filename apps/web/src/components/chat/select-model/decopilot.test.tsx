import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ModelTierSection } from "./decopilot";
import type { AiProviderModel } from "../../../hooks/collections/use-ai-providers";

function makeModel(overrides: Partial<AiProviderModel> = {}): AiProviderModel {
  return {
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet-5",
    title: "Anthropic: Claude Sonnet 5",
    description: null,
    logo: null,
    capabilities: ["text"],
    limits: null,
    costs: null,
    ...overrides,
  };
}

describe("ModelTierSection", () => {
  it("renders nothing for an empty tier", () => {
    const { container } = render(
      <ModelTierSection
        label="Smarter"
        models={[]}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders each model as a focusable, keyboard-operable button", () => {
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    // A real <button> — not a div with onClick — is what makes the row
    // reachable via Tab and activatable via Enter/Space for keyboard users.
    const row = getByRole("button", { name: /Claude Sonnet 5/ });
    expect(row).toHaveAttribute("type", "button");
  });

  it("calls onSelect with the clicked model", () => {
    const onSelect = mock((_m: AiProviderModel) => {});
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={onSelect}
        onHover={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(onSelect).toHaveBeenCalledWith(model);
  });

  it("calls onHover when the row receives keyboard focus, not just a mouse hover", () => {
    const onHover = mock((_m: AiProviderModel) => {});
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={() => {}}
        onHover={onHover}
      />,
    );
    // Keyboard users tabbing through rows never trigger onMouseEnter, so the
    // details panel would otherwise stay blank until Enter is pressed.
    fireEvent.focus(getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(onHover).toHaveBeenCalledWith(model);
  });
});
