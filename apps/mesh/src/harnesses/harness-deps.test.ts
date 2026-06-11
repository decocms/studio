import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { HarnessDeps } from "./harness-deps";
import type { SandboxClient } from "./sandbox-client";
import type { HarnessStreamInput } from "./types";

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

describe("SandboxClient shape", () => {
  test("dispatch returns an AsyncIterable<UIMessageChunk>", async () => {
    const chunks: UIMessageChunk[] = [{ type: "start" } as UIMessageChunk];
    const client: SandboxClient = {
      dispatch(_input: HarnessStreamInput) {
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    };
    const out: UIMessageChunk[] = [];
    for await (const c of client.dispatch({} as HarnessStreamInput)) {
      out.push(c);
    }
    expect(out).toEqual(chunks);
  });
});
