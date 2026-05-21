import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveSandboxProviderKindFromEnv } from "./index";

describe("resolveSandboxProviderKindFromEnv", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_RUNNER;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("defaults to 'remote-user' when nothing is configured", () => {
    expect(resolveSandboxProviderKindFromEnv()).toBe("remote-user");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=docker", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "docker";
    expect(resolveSandboxProviderKindFromEnv()).toBe("docker");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=agent-sandbox", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "agent-sandbox";
    expect(resolveSandboxProviderKindFromEnv()).toBe("agent-sandbox");
  });

  it("throws on unknown STUDIO_SANDBOX_RUNNER value", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "nonsense";
    expect(() => resolveSandboxProviderKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_RUNNER/,
    );
  });

  it("rejects the retired 'host' runner kind", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "host";
    expect(() => resolveSandboxProviderKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_RUNNER/,
    );
  });
});
