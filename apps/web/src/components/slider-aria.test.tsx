import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Slider } from "@decocms/ui/components/slider.tsx";

/** The `@decocms/ui` Slider's thumbs, as the browser renders them. */
function thumbs() {
  return [...document.querySelectorAll('[role="slider"]')];
}

describe("Slider thumbs' accessible names", () => {
  test("without thumbLabel, a range keeps Radix's Minimum/Maximum names, as before", () => {
    render(<Slider defaultValue={[10, 90]} />);
    const [low, high] = thumbs();
    expect(low?.getAttribute("aria-label")).toBe("Minimum");
    expect(high?.getAttribute("aria-label")).toBe("Maximum");
    expect(low?.hasAttribute("aria-valuetext")).toBe(false);
  });

  test("thumbLabel and thumbValueText name each thumb when given", () => {
    render(
      <Slider defaultValue={[40]} thumbLabel="Share" thumbValueText="40%" />,
    );
    const [only] = thumbs();
    expect(only?.getAttribute("aria-label")).toBe("Share");
    expect(only?.getAttribute("aria-valuetext")).toBe("40%");
  });
});
