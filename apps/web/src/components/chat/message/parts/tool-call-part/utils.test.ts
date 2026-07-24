import { describe, expect, test } from "bun:test";
import { formatToolMetrics, toTitleCase } from "./utils.tsx";

describe("toTitleCase", () => {
  test("converts SCREAMING_SNAKE_CASE to Title Case", () => {
    expect(toTitleCase("SCREAMING_SNAKE_CASE")).toBe("Screaming Snake Case");
  });

  test("converts snake_case to Title Case", () => {
    expect(toTitleCase("some_tool")).toBe("Some Tool");
  });

  test("converts kebab-case to Title Case", () => {
    expect(toTitleCase("some-tool")).toBe("Some Tool");
  });

  test("returns empty string for empty input", () => {
    expect(toTitleCase("")).toBe("");
  });

  test("returns title-cased single word", () => {
    expect(toTitleCase("SINGLE")).toBe("Single");
  });

  test("handles mixed separators", () => {
    expect(toTitleCase("hello_world-foo")).toBe("Hello World Foo");
  });
});

describe("formatToolMetrics", () => {
  test("returns usage only when only tokens provided", () => {
    expect(formatToolMetrics({ usage: { tokens: 120 } })).toBe("120 tokens");
  });

  test("returns latency only when only latency provided", () => {
    expect(formatToolMetrics({ latencySeconds: 0.3 })).toBe("0.3s");
  });

  test("returns both when usage and latency provided", () => {
    expect(
      formatToolMetrics({
        usage: { tokens: 120 },
        latencySeconds: 0.3,
      }),
    ).toBe("120 tokens · 0.3s");
  });

  test("returns null when neither provided", () => {
    expect(formatToolMetrics({})).toBeNull();
  });

  test("formats large numbers with locale", () => {
    expect(formatToolMetrics({ usage: { tokens: 1234567 } })).toBe(
      "1,234,567 tokens",
    );
  });

  test("omits cost when cost is 0", () => {
    expect(formatToolMetrics({ usage: { tokens: 120, cost: 0 } })).toBe(
      "120 tokens",
    );
  });

  test("includes cost when cost > 0", () => {
    expect(formatToolMetrics({ usage: { tokens: 120, cost: 0.0012 } })).toBe(
      "120 tokens · $0.0012",
    );
  });

  test("includes cost when cost is optional and not provided", () => {
    expect(formatToolMetrics({ usage: { tokens: 120 } })).toBe("120 tokens");
  });
});
