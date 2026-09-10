import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { AgentAvatar, buildImageIconString } from "./agent-icon";

describe("AgentAvatar", () => {
  /**
   * The glyph carries its size and its color as CLASSES, not just as the
   * `size` prop and an inherited `color`.
   *
   * `CommandItem` and `DropdownMenuItem` both carry
   * `[&_svg:not([class*='size-'])]:size-4` and
   * `[&_svg:not([class*='text-'])]:text-muted-foreground`, and a CSS rule beats
   * a presentational `width`/`height` attribute — so a class-less glyph was
   * blown to 16px and repainted grey inside every menu and command list in the
   * app, while the same avatar rendered correctly just outside one. Both
   * `:not()` guards are satisfied only by the classes asserted here.
   */
  it.each([
    ["2xs", "size-4", "size-3"],
    ["xs", "w-6", "size-3.5"],
    ["sm", "w-8", "size-4"],
    ["sm+", "w-10", "size-5"],
    ["md", "w-12", "size-6"],
    ["lg", "w-16", "size-8"],
    ["xl", "w-20", "size-10"],
  ] as const)(
    "stamps the glyph's size and color so a menu cannot override them (%s)",
    (size, boxClass, glyphClass) => {
      const { container } = render(
        <AgentAvatar icon="icon://folder" name="Test Agent" size={size} />,
      );

      expect(container.firstElementChild?.className).toContain(boxClass);

      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      // The class is what survives a menu's `[&_svg:not([class*='size-'])]`.
      expect(svg?.getAttribute("class")).toContain(glyphClass);
      expect(svg?.getAttribute("class")).toMatch(/text-\w+-\d+/);
    },
  );

  it("applies the picker's palette color as a background for an uploaded image icon", () => {
    const { container } = render(
      <AgentAvatar
        icon={buildImageIconString("https://example.com/logo.png", "red")}
        name="Test Agent"
      />,
    );

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.parentElement?.className).toContain("bg-red-100");
    expect(img).toHaveClass("h-full", "w-full", "object-contain");
    expect(img).not.toHaveClass("p-3");
  });

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
