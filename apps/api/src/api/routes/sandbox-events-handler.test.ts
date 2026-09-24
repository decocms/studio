import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HostedSandboxProvider } from "@decocms/sandbox/provider";
import { SandboxDrainingError } from "@decocms/sandbox/provider/remote";
import type { StudioContext } from "../../core/studio-context";
import type { Env } from "../hono-env";
import { handleVmEvents } from "./sandbox-events-handler";

const CLAIM = "claim-1a2b3c";
const BRANCH = "feat/example";
const METADATA = {
  sandboxMap: {
    "user-1": {
      [BRANCH]: {
        "agent-sandbox": {
          sandboxHandle: CLAIM,
          previewUrl: "https://claim-1a2b3c.sandboxes.example.com/",
        },
      },
    },
  },
};

function staleRunner(deleteImpl: (handle: string) => Promise<void>) {
  return {
    alive: async () => false,
    delete: mock(deleteImpl),
    renewTtl: async () => {},
  } as unknown as HostedSandboxProvider & {
    delete: ReturnType<typeof mock>;
  };
}

async function openEvents(runner: HostedSandboxProvider) {
  const update = mock(async () => {});
  const ctx = {
    storage: {
      virtualMcps: {
        findById: async () => ({ id: "vmcp_1", metadata: METADATA }),
        update,
      },
    },
  } as unknown as StudioContext;
  const app = new Hono<Env>();
  app.get("/events", (c) =>
    handleVmEvents(c, {
      ctx,
      claimName: CLAIM,
      runner,
      virtualMcpId: "vmcp_1",
      branch: BRANCH,
      userId: "user-1",
      virtualMcpMetadata: METADATA,
    }),
  );
  const body = await (await app.request("/events")).text();
  return { body, update };
}

describe("handleVmEvents on a stale handle", () => {
  it("emits gone and clears the entry once the claim is deleted", async () => {
    const runner = staleRunner(async () => {});
    const { body, update } = await openEvents(runner);

    expect(runner.delete).toHaveBeenCalledWith(CLAIM);
    expect(body).toContain("event: gone");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry and ends without gone while the claim is draining", async () => {
    const runner = staleRunner(async (handle) => {
      throw new SandboxDrainingError(handle);
    });
    const { body, update } = await openEvents(runner);

    expect(runner.delete).toHaveBeenCalledWith(CLAIM);
    expect(body).not.toContain("event: gone");
    expect(update).not.toHaveBeenCalled();
  });
});
