import { describe, expect, test } from "bun:test";
import type { HarnessDeps } from "./harness-deps";

describe("HarnessDeps shape", () => {
  test("a minimal cluster bag with all optional hooks omitted conforms", () => {
    const deps = {
      onRead: async () => "",
      onWrite: async () => {},
      onEdit: async () => {},
      onBash: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      onGlob: async () => [],
      onGrep: async () => [],
      objectStorage: {} as HarnessDeps["objectStorage"],
      allowHttpExternalUrls: false,
      mcpForAgent: async () =>
        ({}) as Awaited<ReturnType<HarnessDeps["mcpForAgent"]>>,
    } satisfies HarnessDeps;
    // Cast to the full interface so tsc sees the optional fields
    const fullDeps: HarnessDeps = deps;
    expect(fullDeps.researchJob).toBeUndefined();
    expect(fullDeps.interests).toBeUndefined();
    expect(fullDeps.telemetry).toBeUndefined();
    expect(fullDeps.browserless).toBeUndefined();
  });

  test("researchJob is an async generator hook (stateful streaming)", async () => {
    const deps: Pick<HarnessDeps, "researchJob"> = {
      // eslint-disable-next-line require-yield
      async *researchJob() {
        yield { progress: "started" };
        return { ok: true } as Awaited<unknown> as never;
      },
    };
    const gen = deps.researchJob!(
      {} as Parameters<NonNullable<HarnessDeps["researchJob"]>>[0],
    );
    const first = await gen.next();
    expect(first.value).toEqual({ progress: "started" });
  });
});
