import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { sandboxWireUserMessage } from "./wire-user-message";

const user: UIMessage = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "change the h1" }],
};
const system = (...texts: string[]) => ({
  parts: texts.map((text) => ({ type: "text", text })),
});

describe("sandboxWireUserMessage", () => {
  test("is the message itself when there is nothing to add", () => {
    expect(sandboxWireUserMessage(user, { turnContext: [] })).toBe(user);
    expect(sandboxWireUserMessage(user, { turnContext: [system("  ")] })).toBe(
      user,
    );
  });

  test("puts the open file's context after the user's words", () => {
    const wired = sandboxWireUserMessage(user, {
      turnContext: [system("### Currently Open File\n- Name: deck.html")],
    });
    expect(wired.parts).toEqual([
      { type: "text", text: "change the h1" },
      { type: "text", text: "### Currently Open File\n- Name: deck.html" },
    ]);
  });

  test("puts prior conversation before the message and context after it", () => {
    const wired = sandboxWireUserMessage(user, {
      historyPrefix: "earlier turns",
      turnContext: [system("ctx")],
    });
    expect(wired.parts.map((p) => (p as { text: string }).text)).toEqual([
      "earlier turns",
      "change the h1",
      "ctx",
    ]);
  });
});
