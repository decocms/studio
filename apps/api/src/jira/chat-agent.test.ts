import { describe, expect, it, mock } from "bun:test";
import type { VirtualMCPStorage } from "@/storage/virtual";
import {
  JIRA_CHAT_AGENT_TOOLS,
  jiraChatAgentId,
  syncJiraChatAgent,
} from "./chat-agent";

const ORG = "org_1";
const ID = jiraChatAgentId(ORG);

function fakeStorage(existing: { metadata?: unknown } | null) {
  let row = existing;
  const storage = {
    findById: mock(async () => row),
    create: mock(async (_org: string, _user: string, data: unknown) => {
      row = data as { metadata?: unknown };
      return row;
    }),
    update: mock(async () => row),
    delete: mock(async () => {
      row = null;
    }),
  };
  return {
    storage,
    virtualMcps: storage as unknown as VirtualMCPStorage,
  };
}

const sync = (virtualMcps: VirtualMCPStorage, enabled: boolean) =>
  syncJiraChatAgent(virtualMcps, {
    organizationId: ORG,
    userId: "user_1",
    enabled,
  });

describe("syncJiraChatAgent", () => {
  it("creates the agent when the integration is enabled and it does not exist", async () => {
    const { storage, virtualMcps } = fakeStorage(null);

    await sync(virtualMcps, true);

    expect(storage.create).toHaveBeenCalledTimes(1);
    const [org, user, data, opts] = storage.create.mock.calls[0] as unknown as [
      string,
      string,
      {
        connections: Array<{ connection_id: string; selected_tools: string[] }>;
      },
      { id: string },
    ];
    expect([org, user, opts]).toEqual([ORG, "user_1", { id: ID }]);
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]?.connection_id).toBe(`${ORG}_self`);
    expect(data.connections[0]?.selected_tools).toEqual([
      ...JIRA_CHAT_AGENT_TOOLS,
    ]);
  });

  it("refreshes an existing agent's tools and instructions, keeping its other metadata", async () => {
    const { storage, virtualMcps } = fakeStorage({
      metadata: { instructions: "old", pinnedNote: "keep" },
    });

    await sync(virtualMcps, true);

    expect(storage.create).not.toHaveBeenCalled();
    const [, , patch] = storage.update.mock.calls[0] as unknown as [
      string,
      string,
      { metadata: Record<string, unknown> },
    ];
    expect(patch.metadata.pinnedNote).toBe("keep");
    expect(patch.metadata.instructions).not.toBe("old");
  });

  it("removes the agent when the integration is disabled or gone", async () => {
    const { storage, virtualMcps } = fakeStorage({ metadata: {} });

    await sync(virtualMcps, false);

    expect(storage.delete).toHaveBeenCalledWith(ID);
  });

  it("does nothing when disabled and there is no agent", async () => {
    const { storage, virtualMcps } = fakeStorage(null);

    await sync(virtualMcps, false);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.create).not.toHaveBeenCalled();
  });

  it("falls back to a refresh when another replica created it first", async () => {
    const { storage, virtualMcps } = fakeStorage(null);
    storage.findById
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ metadata: {} }));
    storage.create.mockImplementationOnce(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });

    await sync(virtualMcps, true);

    expect(storage.update).toHaveBeenCalledTimes(1);
  });

  it("rethrows a create failure that was not a race", async () => {
    const { storage, virtualMcps } = fakeStorage(null);
    storage.create.mockImplementationOnce(async () => {
      throw new Error("database is down");
    });

    await expect(sync(virtualMcps, true)).rejects.toThrow("database is down");
  });
});
