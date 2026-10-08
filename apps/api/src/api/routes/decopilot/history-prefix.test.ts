import { describe, expect, test } from "bun:test";
import { buildHistoryPrefix } from "./history-prefix";

const text = (role: string, ...texts: string[]) => ({
  role,
  parts: texts.map((t) => ({ type: "text", text: t })),
});

describe("buildHistoryPrefix", () => {
  test("no history, or no text in it, is no prefix", () => {
    expect(buildHistoryPrefix([])).toBeNull();
    expect(
      buildHistoryPrefix([
        { role: "assistant", parts: [{ type: "tool-bash", input: {} }] },
        text("system", "you are helpful"),
        text("user", "   "),
      ]),
    ).toBeNull();
  });

  test("keeps only user/assistant text, chronologically", () => {
    const prefix = buildHistoryPrefix([
      text("user", "make the header blue"),
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking out loud" },
          { type: "tool-edit", input: { path: "a.css" } },
          { type: "text", text: "Done, it is blue." },
        ],
      },
      text("system", "hidden instructions"),
      text("user", "now red"),
    ]);
    expect(prefix).not.toBeNull();
    const body = prefix ?? "";
    expect(body).not.toContain("thinking out loud");
    expect(body).not.toContain("a.css");
    expect(body).not.toContain("hidden instructions");
    const order = [
      "User: make the header blue",
      "Assistant: Done, it is blue.",
      "User: now red",
    ].map((line) => body.indexOf(line));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("an over-budget history keeps the newest turns", () => {
    const old = "o".repeat(400);
    const recent = "r".repeat(40);
    const prefix =
      buildHistoryPrefix(
        [text("user", old), text("assistant", recent), text("user", recent)],
        30,
      ) ?? "";
    expect(prefix).not.toContain(old);
    expect(prefix).toContain(`Assistant: ${recent}`);
    expect(prefix).toContain(`User: ${recent}`);
  });

  test("an oversized newest turn is cut to its end, not dropped", () => {
    const huge = `${"a".repeat(10_000)}THE END`;
    const prefix = buildHistoryPrefix([text("assistant", huge)], 10) ?? "";
    expect(prefix).toContain("THE END");
    expect(prefix).not.toContain("a".repeat(100));
  });
});
