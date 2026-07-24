import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { ConnectionIcon } from "./monitor-connections-panel";

// Mirrors how ConnectionRow renders ConnectionIcon: keyed by the icon URL so
// a URL change remounts (and resets) the child's internal error state.
function KeyedConnectionIcon({ icon }: { icon: string }) {
  return <ConnectionIcon key={icon} icon={icon} title="Test MCP" />;
}

describe("ConnectionIcon", () => {
  it("recovers after an image load error once a new icon URL is set", () => {
    const { container, rerender } = render(
      <KeyedConnectionIcon icon="https://example.com/broken.png" />,
    );

    const brokenImg = container.querySelector("img");
    expect(brokenImg).toBeInTheDocument();
    fireEvent.error(brokenImg!);

    // Falls back to the initials avatar (no <img>).
    expect(container.querySelector("img")).not.toBeInTheDocument();

    rerender(<KeyedConnectionIcon icon="https://example.com/good.png" />);

    // A new URL must render as an image again, not stay stuck on fallback.
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/good.png",
    );
  });
});
