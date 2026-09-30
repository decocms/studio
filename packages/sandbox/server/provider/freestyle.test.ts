import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import { type Freestyle, FreestyleApiError } from "freestyle";
import { FreestyleSandboxProvider } from "./freestyle";

const ID = { userId: "u1", projectRef: "agent:org:vmcp:feature-x" };
const realFetch = globalThis.fetch;

/** Every daemon call answers 200; ghcr answers 404 for tags named `missing`. */
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://ghcr.io/token")) {
        return Response.json({ token: "t" });
      }
      if (url.startsWith("https://ghcr.io/v2/")) {
        return new Response(null, {
          status: url.endsWith("/missing") ? 404 : 200,
        });
      }
      return Response.json({});
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeClient(opts: { autoDeleteCap?: boolean } = {}) {
  const creates: Record<string, unknown>[] = [];
  const vm = {
    exec: async () => ({ statusCode: 0, stdout: "" }),
    delete: async () => {},
  };
  const client = {
    vms: {
      get: async () => {
        throw new FreestyleApiError(404, { code: "NOT_FOUND" });
      },
      snapshots: { get: async () => ({}) },
      create: async (options: Record<string, unknown>) => {
        creates.push(options);
        if (opts.autoDeleteCap && options.autoDeleteSeconds !== undefined) {
          throw new FreestyleApiError(400, { code: "INVALID_REQUEST" });
        }
        return { vm };
      },
    },
  };
  return { client: client as unknown as Freestyle, creates };
}

describe("FreestyleSandboxProvider", () => {
  test("creates VMs that are deleted after days paused", async () => {
    const { client, creates } = fakeClient();
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)?.autoDeleteSeconds).toBe(3 * 24 * 60 * 60);
    provider.close();
  });

  test("takes the plan's cap when it refuses autoDeleteSeconds", async () => {
    const { client, creates } = fakeClient({ autoDeleteCap: true });
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)).not.toHaveProperty("autoDeleteSeconds");
    provider.close();
  });

  test("is unavailable while its image does not exist", async () => {
    const { client } = fakeClient();
    const missing = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      image: "ghcr.io/decocms/studio/studio-sandbox-go:missing",
    });
    const present = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      image: "ghcr.io/decocms/studio/studio-sandbox-go:1.0.0",
    });
    await sleep(0);
    expect(missing.available()).toBe(false);
    expect(present.available()).toBe(true);
    missing.close();
    present.close();
  });
});
