import { describe, expect, it } from "bun:test";
import type { RuntimeEnvEntry } from "@decocms/shared/sdk";
import type { StudioContext } from "../../core/studio-context";
import { SecretAccessDeniedError } from "../../storage/secrets";
import { pushSandboxEnv, resolveSandboxEnv } from "./resolve-env";

const ctxWith = (secrets: Record<string, string>, resolved: string[] = []) =>
  ({
    storage: {
      secrets: {
        resolveById: async (id: string) => {
          resolved.push(id);
          const value = secrets[id];
          if (value === undefined) throw new SecretAccessDeniedError(id);
          return { value };
        },
      },
    },
  }) as unknown as StudioContext;

const resolve = (
  entries: RuntimeEnvEntry[],
  buildEnabled: boolean,
  secrets: Record<string, string> = {},
  resolved: string[] = [],
) =>
  resolveSandboxEnv({
    ctx: ctxWith(secrets, resolved),
    orgId: "org_1",
    userId: "user_1",
    entries,
    buildEnabled,
  });

const runnerRecording = (pushed: unknown[], fail = false) => ({
  proxyDaemonRequest: async (
    _handle: string,
    _path: string,
    init?: RequestInit,
  ) => {
    if (fail) throw new Error("daemon unreachable");
    pushed.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  },
});

const BUILD_SECRET: RuntimeEnvEntry = {
  key: "NPM_TOKEN",
  kind: "secret",
  secretId: "sec_private",
  scope: "build",
};
const BUILD_LITERAL: RuntimeEnvEntry = {
  key: "REGISTRY",
  kind: "literal",
  value: "https://registry.example.test",
  scope: "build",
};

describe("resolveSandboxEnv", () => {
  it("has nothing to say about build env when the flag is off and none is declared", async () => {
    const out = await resolve(
      [{ key: "A", kind: "literal", value: "1" }],
      false,
    );
    expect(out).toEqual({
      env: { A: "1" },
      buildEnv: undefined,
      buildEnvComplete: true,
    });
  });

  it("clears, without touching the vault, when the flag is off but build entries remain", async () => {
    const resolved: string[] = [];
    const out = await resolve(
      [BUILD_SECRET],
      false,
      { sec_private: "v" },
      resolved,
    );
    expect(out.buildEnv).toEqual({});
    expect(resolved).toEqual([]);
  });

  it("marks the set incomplete when a build secret is not resolvable by the caller", async () => {
    const out = await resolve([BUILD_LITERAL, BUILD_SECRET], true);
    expect(out.buildEnv).toEqual({ REGISTRY: BUILD_LITERAL.value });
    expect(out.buildEnvComplete).toBe(false);
  });

  it("a skipped runtime secret leaves the build set complete", async () => {
    const out = await resolve(
      [{ key: "API_KEY", kind: "secret", secretId: "sec_gone" }, BUILD_LITERAL],
      true,
    );
    expect(out.buildEnvComplete).toBe(true);
  });
});

describe("pushSandboxEnv", () => {
  it("withholds an incomplete build env so it cannot replace the full one", async () => {
    const pushed: unknown[] = [];
    await pushSandboxEnv({
      runner: runnerRecording(pushed),
      handle: "h",
      resolved: await resolve(
        [{ key: "A", kind: "literal", value: "1" }, BUILD_SECRET],
        true,
      ),
    });
    expect(pushed).toEqual([{ env: { A: "1" } }]);

    pushed.length = 0;
    await pushSandboxEnv({
      runner: runnerRecording(pushed),
      handle: "h",
      resolved: await resolve([BUILD_SECRET], true),
      only: "build",
    });
    expect(pushed).toEqual([]);
  });

  it("sends an empty complete set, which is how a deleted build var leaves", async () => {
    const pushed: unknown[] = [];
    await pushSandboxEnv({
      runner: runnerRecording(pushed),
      handle: "h",
      resolved: await resolve([], true),
    });
    expect(pushed).toEqual([{ buildEnv: {} }]);
  });

  it("does not fail the step when only clearing an empty build env fails", async () => {
    await pushSandboxEnv({
      runner: runnerRecording([], true),
      handle: "h",
      resolved: await resolve([], true),
    });
  });

  it("still fails when a real env push fails", async () => {
    expect(
      pushSandboxEnv({
        runner: runnerRecording([], true),
        handle: "h",
        resolved: await resolve([BUILD_LITERAL], true),
      }),
    ).rejects.toThrow("daemon unreachable");
  });
});
