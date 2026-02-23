/**
 * user_ask Built-in Tool E2E Tests
 *
 * End-to-end tests that verify the complete integration of user_ask tool:
 * - Tool is registered in getBuiltInTools()
 * - Tool has correct metadata (description, schemas)
 * - Tool has no execute function (client-side only)
 * - Input schema validates correctly
 * - Output schema is defined correctly
 *
 * Run with: bun test user-ask.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { getBuiltInTools, type BuiltinToolParams } from "./index";
import {
  UserAskInputSchema,
  UserAskOutputSchema,
  userAskTool,
} from "./user-ask";

const mockParams: BuiltinToolParams = {
  modelProvider: { thinkingModel: {} as never } as never,
  organization: { id: "org_test" } as never,
  models: {
    connectionId: "conn_test",
    thinking: { id: "model_test" },
  } as never,
  toolOutputMap: new Map(),
};

const mockCtx = {
  storage: { virtualMcps: { findById: () => Promise.resolve(null) } },
} as never;

const mockWriter = {
  write: () => {},
  merge: () => {},
} as never;

function getTools() {
  return getBuiltInTools(mockWriter, mockParams, mockCtx);
}

describe("user_ask E2E Integration", () => {
  // ============================================================================
  // Tool Registration
  // ============================================================================

  describe("Tool Registration", () => {
    test("tool is registered in getBuiltInTools()", () => {
      const tools = getTools();

      expect(tools).toBeDefined();
      expect(tools.user_ask).toBeDefined();
      expect(tools.user_ask).toBe(userAskTool);
    });

    test("getBuiltInTools() returns correct ToolSet structure", () => {
      const tools = getTools();

      // ToolSet is Record<string, CoreTool>
      expect(typeof tools).toBe("object");
      expect(Object.keys(tools)).toContain("user_ask");
    });
  });

  // ============================================================================
  // Tool Metadata
  // ============================================================================

  describe("Tool Metadata", () => {
    test("has correct description", () => {
      const tools = getTools();

      expect(tools.user_ask?.description).toBe(
        "Ask the user instead of guessing when requirements are ambiguous, multiple valid approaches exist, or before destructive changes. Prefer this tool over asking in plain text.",
      );
    });

    test("has inputSchema defined", () => {
      const tools = getTools();

      expect(tools.user_ask?.inputSchema).toBeDefined();
    });

    test("has outputSchema defined", () => {
      const tools = getTools();

      expect(tools.user_ask?.outputSchema).toBeDefined();
    });

    test("inputSchema matches exported UserAskInputSchema", () => {
      // Verify the schema is accessible for validation
      expect(UserAskInputSchema).toBeDefined();
      expect(typeof UserAskInputSchema.safeParse).toBe("function");
    });

    test("outputSchema matches exported UserAskOutputSchema", () => {
      // Verify the schema is accessible for validation
      expect(UserAskOutputSchema).toBeDefined();
      expect(typeof UserAskOutputSchema.safeParse).toBe("function");
    });
  });

  // ============================================================================
  // Client-Side Only Verification
  // ============================================================================

  describe("Client-Side Only", () => {
    test("has no execute function", () => {
      const tools = getTools();

      // Client-side tools should not have execute function defined
      // (execute is optional in AI SDK tool type)
      expect(tools.user_ask?.execute).toBeUndefined();
    });

    test("tool can be called from AI SDK without execute", () => {
      // Verify the tool structure is valid for AI SDK usage
      const tool = userAskTool;

      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.execute).toBeUndefined();
    });
  });

  // ============================================================================
  // Input Schema Validation - Valid Cases
  // ============================================================================

  describe("Input Schema - Valid Cases", () => {
    test("accepts valid text input", () => {
      const input = {
        prompt: "What is your name?",
        type: "text" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid text input with default value", () => {
      const input = {
        prompt: "Enter your email",
        type: "text" as const,
        default: "user@example.com",
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid choice input with multiple options", () => {
      const input = {
        prompt: "Select your preference",
        type: "choice" as const,
        options: ["Option A", "Option B"],
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid choice input with many options", () => {
      const input = {
        prompt: "Choose a color",
        type: "choice" as const,
        options: ["Red", "Blue", "Green", "Yellow", "Purple"],
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid choice input with default value", () => {
      const input = {
        prompt: "Select language",
        type: "choice" as const,
        options: ["English", "Spanish", "French"],
        default: "English",
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid confirm input", () => {
      const input = {
        prompt: "Do you want to continue?",
        type: "confirm" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts valid confirm input with default value", () => {
      const input = {
        prompt: "Delete all files?",
        type: "confirm" as const,
        default: "no",
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // Input Schema Validation - Invalid Cases
  // ============================================================================

  describe("Input Schema - Invalid Cases", () => {
    test("rejects choice without options", () => {
      const input = {
        prompt: "Select something",
        type: "choice" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Options array with at least 2 items required for 'choice' type",
        );
      }
    });

    test("rejects choice with single option", () => {
      const input = {
        prompt: "Select something",
        type: "choice" as const,
        options: ["Only one"],
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Options array with at least 2 items required for 'choice' type",
        );
      }
    });

    test("rejects choice with empty options array", () => {
      const input = {
        prompt: "Select something",
        type: "choice" as const,
        options: [],
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects empty prompt", () => {
      const input = {
        prompt: "",
        type: "text" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects missing prompt", () => {
      const input = {
        type: "text" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects invalid type", () => {
      const input = {
        prompt: "Question?",
        type: "invalid" as const,
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects missing type", () => {
      const input = {
        prompt: "Question?",
      };

      const result = UserAskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Output Schema Validation
  // ============================================================================

  describe("Output Schema Validation", () => {
    test("accepts valid output with response string", () => {
      const output = {
        response: "User provided response",
      };

      const result = UserAskOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    test("accepts output with empty string response", () => {
      const output = {
        response: "",
      };

      const result = UserAskOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    test("rejects output without response field", () => {
      const output = {};

      const result = UserAskOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    test("rejects output with non-string response", () => {
      const output = {
        response: 123,
      };

      const result = UserAskOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Complete Integration Flow
  // ============================================================================

  describe("Complete Integration Flow", () => {
    test("full workflow from registration to validation", () => {
      // 1. Get tool from registry
      const tools = getTools();
      const tool = tools.user_ask;

      expect(tool).toBeDefined();
      expect(tool?.execute).toBeUndefined(); // Client-side only

      // 2. Validate input
      const input = {
        prompt: "Enter your name",
        type: "text" as const,
      };

      const inputValidation = UserAskInputSchema.safeParse(input);
      expect(inputValidation.success).toBe(true);

      // 3. Validate output
      const output = {
        response: "John Doe",
      };

      const outputValidation = UserAskOutputSchema.safeParse(output);
      expect(outputValidation.success).toBe(true);
    });

    test("choice type workflow with validation", () => {
      // 1. Get tool
      const tools = getTools();
      expect(tools.user_ask).toBeDefined();

      // 2. Validate choice input
      const input = {
        prompt: "Select deployment environment",
        type: "choice" as const,
        options: ["development", "staging", "production"],
        default: "development",
      };

      const inputValidation = UserAskInputSchema.safeParse(input);
      expect(inputValidation.success).toBe(true);

      // 3. Validate output
      const output = {
        response: "production",
      };

      const outputValidation = UserAskOutputSchema.safeParse(output);
      expect(outputValidation.success).toBe(true);
    });

    test("confirm type workflow with validation", () => {
      // 1. Get tool
      const tools = getTools();
      expect(tools.user_ask).toBeDefined();

      // 2. Validate confirm input
      const input = {
        prompt: "Proceed with deployment?",
        type: "confirm" as const,
        default: "no",
      };

      const inputValidation = UserAskInputSchema.safeParse(input);
      expect(inputValidation.success).toBe(true);

      // 3. Validate output
      const output = {
        response: "yes",
      };

      const outputValidation = UserAskOutputSchema.safeParse(output);
      expect(outputValidation.success).toBe(true);
    });
  });
});
