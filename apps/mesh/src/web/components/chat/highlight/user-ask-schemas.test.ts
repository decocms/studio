import { describe, expect, test } from "bun:test";
import { buildCombinedSchema } from "./user-ask-schemas";

const choicePart = {
  toolCallId: "q1",
  input: {
    type: "choice" as const,
    prompt: "Pick one",
    options: ["A", "B"],
  },
};

const textPart = {
  toolCallId: "q2",
  input: { type: "text" as const, prompt: "Type something" },
};

const confirmPart = {
  toolCallId: "q3",
  input: { type: "confirm" as const, prompt: "OK?" },
};

describe("buildCombinedSchema — choice", () => {
  test("accepts a value with a non-null option", () => {
    const schema = buildCombinedSchema([choicePart]);
    const result = schema.safeParse({
      q1: { option: "A", draft: "" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts a value with non-empty draft and null option", () => {
    const schema = buildCombinedSchema([choicePart]);
    const result = schema.safeParse({
      q1: { option: null, draft: "foo" },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a value with null option and empty draft", () => {
    const schema = buildCombinedSchema([choicePart]);
    const result = schema.safeParse({
      q1: { option: null, draft: "" },
    });
    expect(result.success).toBe(false);
  });

  test("preserves draft when option is set (round-trip)", () => {
    const schema = buildCombinedSchema([choicePart]);
    const value = { q1: { option: "A", draft: "foo" } };
    const parsed = schema.parse(value);
    expect(parsed.q1).toEqual({ option: "A", draft: "foo" });
  });
});

describe("buildCombinedSchema — text and confirm unchanged", () => {
  test("text requires a non-empty response", () => {
    const schema = buildCombinedSchema([textPart]);
    expect(schema.safeParse({ q2: { response: "" } }).success).toBe(false);
    expect(schema.safeParse({ q2: { response: "hi" } }).success).toBe(true);
  });

  test("confirm only accepts yes/no", () => {
    const schema = buildCombinedSchema([confirmPart]);
    expect(schema.safeParse({ q3: { response: "maybe" } }).success).toBe(false);
    expect(schema.safeParse({ q3: { response: "yes" } }).success).toBe(true);
    expect(schema.safeParse({ q3: { response: "no" } }).success).toBe(true);
  });
});
