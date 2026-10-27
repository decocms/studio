import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, it } from "bun:test";
import { renderHook } from "@testing-library/react";
import { type DialogWords, useShownWhileClosing } from "./closing-dialog";

const words = (title: string): DialogWords => ({
  title,
  description: "It goes live when you publish.",
});

describe("useShownWhileClosing", () => {
  it("keeps a closing dialog's words through its fade, so its title never falls back", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: DialogWords | null }) =>
        useShownWhileClosing(value, true),
      { initialProps: { value: null as DialogWords | null } },
    );
    expect(result.current).toBeNull();
    rerender({ value: words("Delete page?") });
    expect(result.current?.title).toBe("Delete page?");
    // A new object each render with the same words: no loop, same words.
    rerender({ value: words("Delete page?") });
    rerender({ value: null });
    expect(result.current?.title).toBe("Delete page?");
  });

  it("off (not a hosted v8 draft): exactly the words given, as before", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: DialogWords | null }) =>
        useShownWhileClosing(value, false),
      { initialProps: { value: words("Delete page?") as DialogWords | null } },
    );
    rerender({ value: null });
    expect(result.current).toBeNull();
  });
});
