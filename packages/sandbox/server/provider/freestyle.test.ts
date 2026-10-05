import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Freestyle, FreestyleApiError } from "freestyle";
import { FreestyleSandboxProvider } from "./freestyle";

const ID = { userId: "u1", projectRef: "agent:org:vmcp:feature-x" };
const realFetch = globalThis.fetch;

/** Every daemon call answers 200. */
beforeEach(() => {
  globalThis.fetch = Object.assign(async () => Response.json({}), {
    preconnect: realFetch.preconnect,
  });
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
  test("creates VMs that are deleted after a day paused", async () => {
    const { client, creates } = fakeClient();
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)?.autoDeleteSeconds).toBe(24 * 60 * 60);
    provider.close();
  });

  test("takes the plan's cap when it refuses autoDeleteSeconds", async () => {
    const { client, creates } = fakeClient({ autoDeleteCap: true });
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)).not.toHaveProperty("autoDeleteSeconds");
    provider.close();
  });
});
