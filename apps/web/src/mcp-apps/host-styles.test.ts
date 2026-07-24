import { describe, expect, it } from "bun:test";
import { HOST_TO_SPEC_VAR_MAP, readHostStyles } from "./host-styles";

describe("HOST_TO_SPEC_VAR_MAP", () => {
  it("has no duplicate target (spec) keys", () => {
    const specKeys = HOST_TO_SPEC_VAR_MAP.map(([, key]) => key);
    const unique = new Set(specKeys);
    expect(unique.size).toBe(specKeys.length);
  });

  it("has no duplicate source (host) keys", () => {
    const hostKeys = HOST_TO_SPEC_VAR_MAP.map(([key]) => key);
    const unique = new Set(hostKeys);
    expect(unique.size).toBe(hostKeys.length);
  });
});

describe("readHostStyles", () => {
  it("returns {} when document is undefined (SSR)", () => {
    // document is already undefined in Bun's default env
    expect(readHostStyles()).toEqual({});
  });

  // Helper to set up a minimal DOM mock for tests that need document
  function withDom(fakeGetPropertyValue: (prop: string) => string) {
    const origDoc = globalThis.document;
    const origGCS = globalThis.getComputedStyle;

    // @ts-expect-error — minimal document mock for testing
    globalThis.document = { documentElement: {} };
    globalThis.getComputedStyle = (() => ({
      getPropertyValue: fakeGetPropertyValue,
    })) as unknown as typeof getComputedStyle;

    return () => {
      globalThis.document = origDoc;
      globalThis.getComputedStyle = origGCS;
    };
  }

  it("reads computed CSS variables and maps them to spec keys", () => {
    const fakeValues: Record<string, string> = {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.145 0.01 60)",
      "--border": "oklch(0.915 0.005 80)",
      "--font-sans": '"Inter var", sans-serif',
    };

    const restore = withDom((prop) => fakeValues[prop] ?? "");
    try {
      const result = readHostStyles();
      expect(result.variables).toBeDefined();
      expect(result.variables!["--color-background-primary"]).toBe(
        "oklch(1 0 0)",
      );
      expect(result.variables!["--color-text-primary"]).toBe(
        "oklch(0.145 0.01 60)",
      );
      expect(result.variables!["--color-border-primary"]).toBe(
        "oklch(0.915 0.005 80)",
      );
      expect(result.variables!["--font-sans"]).toBe('"Inter var", sans-serif');
    } finally {
      restore();
    }
  });

  it("skips empty/missing values", () => {
    const restore = withDom((prop) =>
      prop === "--background" ? "oklch(1 0 0)" : "",
    );
    try {
      const result = readHostStyles();
      expect(result.variables!["--color-background-primary"]).toBe(
        "oklch(1 0 0)",
      );
      // Unmapped values should be undefined
      expect(result.variables!["--color-text-primary"]).toBeUndefined();
    } finally {
      restore();
    }
  });
});
