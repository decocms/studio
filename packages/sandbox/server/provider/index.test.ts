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

  it("defaults to 'user-desktop' when nothing is configured", () => {
    expect(resolveSandboxProviderKindFromEnv()).toBe("user-desktop");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=local-docker", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "local-docker";
    expect(resolveSandboxProviderKindFromEnv()).toBe("local-docker");
  });

  it("honors explicit STUDIO_SANDBOX_RUNNER=cluster", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "cluster";
    expect(resolveSandboxProviderKindFromEnv()).toBe("cluster");
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
