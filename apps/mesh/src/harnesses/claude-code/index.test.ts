import { describe, expect, test } from "bun:test";
import { claudeCodeHarnessFactory } from "./index";
import type { HarnessContext } from "../types";

/**
 * Contract tests for the Claude Code harness factory.
 *
 * Exercising the actual streamText loop requires a working `claude` CLI
 * subprocess (the harness spawns it via `ai-sdk-provider-claude-code`),
 * so that path is left to end-to-end / resilience tests. The unit tests
 * here verify only the factory shape — id, create() return type, and
 * stream() being a function. Task 12 will own the integration coverage
 * via the shared dispatcher.
 */
describe("claudeCodeHarnessFactory", () => {
  test("has id 'claude-code'", () => {
    expect(claudeCodeHarnessFactory.id).toBe("claude-code");
  });

  test("create() returns a Harness with id 'claude-code' and a stream() method", () => {
    const harness = claudeCodeHarnessFactory.create({} as HarnessContext);
    expect(harness.id).toBe("claude-code");
    expect(typeof harness.stream).toBe("function");
  });
});
