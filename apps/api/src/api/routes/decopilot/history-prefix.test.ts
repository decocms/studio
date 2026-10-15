import { describe, expect, test } from "bun:test";
import { buildHistoryPrefix, buildUnansweredPrefix } from "./history-prefix";

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

describe("buildUnansweredPrefix", () => {
  const msg = (
    id: string,
    role: string,
    textValue: string,
    metadata?: unknown,
  ) => ({ id, role, parts: [{ type: "text", text: textValue }], metadata });
  const completed = { usage: { inputTokens: 1, outputTokens: 1 } };

  test("carries the messages whose turns failed or were cancelled", () => {
    const prefix =
      buildUnansweredPrefix(
        [
          msg("u1", "user", "propose an org design"),
          msg("a1", "assistant", "Here is the proposal.", completed),
          msg("u2", "user", "Nicacio left; Hugo leads Verify"),
          msg("e2", "assistant", "Error: [SANDBOX_UNREACHABLE] 502"),
          msg("u3", "user", "try again"),
          msg("u4", "user", "try again"),
          msg("u5", "user", "try again"),
          msg("u6", "user", "queued after this turn"),
        ],
        "u5",
      ) ?? "";
    expect(prefix).toContain("Nicacio left; Hugo leads Verify");
    expect(prefix.match(/User: try again/g)).toHaveLength(2);
    expect(prefix).not.toContain("propose an org design");
    expect(prefix).not.toContain("Here is the proposal.");
    expect(prefix).not.toContain("SANDBOX_UNREACHABLE");
    expect(prefix).not.toContain("queued after this turn");
  });

  test("nothing when the previous turn was answered", () => {
    expect(
      buildUnansweredPrefix(
        [
          msg("u1", "user", "hi"),
          msg("a1", "assistant", "hello", completed),
          msg("u2", "user", "next"),
        ],
        "u2",
      ),
    ).toBeNull();
    expect(
      buildUnansweredPrefix([msg("u1", "user", "first")], "u1"),
    ).toBeNull();
  });

  test("a thread whose every turn failed carries all its messages", () => {
    const prefix =
      buildUnansweredPrefix(
        [
          msg("u1", "user", "first ask"),
          msg("e1", "assistant", "Error: boom"),
          msg("u2", "user", "again"),
        ],
        "u2",
      ) ?? "";
    expect(prefix).toContain("first ask");
  });

  test("a request outside the window is no prefix", () => {
    expect(
      buildUnansweredPrefix([msg("u1", "user", "lost")], "missing"),
    ).toBeNull();
  });
});
