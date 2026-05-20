import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveRunnerKindFromEnv } from "./index";

describe("resolveRunnerKindFromEnv", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_RUNNER;
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

  it("throws on unknown STUDIO_SANDBOX_RUNNER value", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "nonsense";
    expect(() => resolveRunnerKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_RUNNER/,
    );
  });
});
