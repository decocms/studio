import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveSandboxProviderKindFromEnv } from "./index";
import {
  normalizeSandboxProviderKind,
  sandboxProviderKindSchema,
} from "./types";

describe("resolveSandboxProviderKindFromEnv", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_PROVIDER;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("defaults to 'user-desktop' when nothing is configured", () => {
    expect(resolveSandboxProviderKindFromEnv()).toBe("user-desktop");
  });

  it("honors explicit STUDIO_SANDBOX_PROVIDER=agent-sandbox", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "agent-sandbox";
    expect(resolveSandboxProviderKindFromEnv()).toBe("agent-sandbox");
  });

  it("normalizes legacy STUDIO_SANDBOX_PROVIDER=cluster", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "cluster";
    expect(resolveSandboxProviderKindFromEnv()).toBe("agent-sandbox");
  });

  it("throws on unknown STUDIO_SANDBOX_PROVIDER value", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "nonsense";
    expect(() => resolveSandboxProviderKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_PROVIDER/,
    );
  });

  it("rejects the retired 'host' provider kind", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "host";
    expect(() => resolveSandboxProviderKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_PROVIDER/,
    );
  });

  it("rejects the retired 'local-docker' provider kind", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "local-docker";
    expect(() => resolveSandboxProviderKindFromEnv()).toThrow(
      /Unknown STUDIO_SANDBOX_PROVIDER/,
    );
  });

  it("normalizes legacy cluster sandbox provider kind to agent-sandbox", () => {
    expect(normalizeSandboxProviderKind("cluster")).toBe("agent-sandbox");
    expect(normalizeSandboxProviderKind("agent-sandbox")).toBe("agent-sandbox");
    expect(normalizeSandboxProviderKind("user-desktop")).toBe("user-desktop");
  });

  it("accepts agent-sandbox as the hosted sandbox provider kind", () => {
    expect(sandboxProviderKindSchema.parse("agent-sandbox")).toBe(
      "agent-sandbox",
    );
  });
});
