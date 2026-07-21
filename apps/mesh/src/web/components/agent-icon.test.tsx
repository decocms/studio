import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { AgentAvatar } from "./agent-icon";

describe("AgentAvatar", () => {
  it("recovers after an image load error once a new URL is set", () => {
    const { container, rerender } = render(
      <AgentAvatar icon="https://example.com/broken.png" name="Test Agent" />,
    );

    const brokenImg = container.querySelector("img");
    expect(brokenImg).toBeInTheDocument();
    fireEvent.error(brokenImg!);

    // Falls back to the deterministic icon avatar (no <img>).
    expect(container.querySelector("img")).not.toBeInTheDocument();

    rerender(
      <AgentAvatar icon="https://example.com/good.png" name="Test Agent" />,
    );

    // A new URL must render as an image again, not stay stuck on fallback.
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/good.png",
    );
  });
});
