import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatModeRowPure } from "./chat-mode-row";

describe("ChatModeRowPure", () => {
  it("returns null when virtual MCP is not clonable", () => {
    const { container } = render(
      <ChatModeRowPure
        clonable={false}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders ModePicker when clonable", () => {
    const { getByTestId } = render(
      <ChatModeRowPure
        clonable={true}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(getByTestId("mode-picker")).toBeInTheDocument();
  });
});
