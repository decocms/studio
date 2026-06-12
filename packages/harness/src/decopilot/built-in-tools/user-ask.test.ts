import { describe, expect, test } from "bun:test";
import { userAskTool, UserAskInputSchema } from "./user-ask";

describe("userAskTool", () => {
  test("has correct metadata", () => {
    expect(userAskTool.description).toContain("Ask the user");
    expect(userAskTool.inputSchema).toBeDefined();
    expect(userAskTool.outputSchema).toBeDefined();
  });

  test("validates text input type", () => {
    const input = {
      prompt: "What is your name?",
      type: "text",
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("validates choice input type with options", () => {
    const input = {
      prompt: "Select your preference",
      type: "choice",
      options: ["Option A", "Option B"],
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("validates confirm input type", () => {
    const input = {
      prompt: "Do you want to continue?",
      type: "confirm",
      default: "yes",
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("rejects choice without options", () => {
    const input = {
      prompt: "Select something",
      type: "choice",
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects empty prompt", () => {
    const input = {
      prompt: "",
      type: "text",
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects choice with single option", () => {
    const input = {
      prompt: "Select something",
      type: "choice",
      options: ["Only one"],
    };

    const result = UserAskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
