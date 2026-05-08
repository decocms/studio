import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveRunnerKindFromEnv } from "./index";

describe("resolveRunnerKindFromEnv", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_RUNNER;
    delete process.env.FREESTYLE_API_KEY;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("defaults to 'host' when nothing is configured", () => {
    expect(resolveRunnerKindFromEnv()).toBe("host");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=docker", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "docker";
    expect(resolveRunnerKindFromEnv()).toBe("docker");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=agent-sandbox", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "agent-sandbox";
    expect(resolveRunnerKindFromEnv()).toBe("agent-sandbox");
  });

  it("returns 'host' even when FREESTYLE_API_KEY is set without explicit runner", () => {
    process.env.FREESTYLE_API_KEY = "sk-test";
    expect(resolveRunnerKindFromEnv()).toBe("host");
  });

  it("returns 'freestyle' when explicit AND FREESTYLE_API_KEY is set", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "freestyle";
    process.env.FREESTYLE_API_KEY = "sk-test";
    expect(resolveRunnerKindFromEnv()).toBe("freestyle");
  });

  it("throws when STUDIO_SANDBOX_RUNNER=freestyle but FREESTYLE_API_KEY is missing", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "freestyle";
    expect(() => resolveRunnerKindFromEnv()).toThrow(/FREESTYLE_API_KEY/);
  });

  it("throws on unknown STUDIO_SANDBOX_RUNNER value", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "nonsense";
    expect(() => resolveRunnerKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_RUNNER/,
    );
  });
});
