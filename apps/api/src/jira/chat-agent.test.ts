import { describe, expect, it, mock } from "bun:test";
import type { VirtualMCPStorage } from "@/storage/virtual";
import {
  JIRA_CHAT_AGENT_INSTRUCTIONS,
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

  it("leaves an existing agent alone: its definition comes from code at run time", async () => {
    const { storage, virtualMcps } = fakeStorage({ metadata: {} });

    await sync(virtualMcps, true);

    expect(storage.create).not.toHaveBeenCalled();
    expect(storage.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
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

  it("accepts a create that lost a race to a concurrent write", async () => {
    const { storage, virtualMcps } = fakeStorage(null);
    storage.findById
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ metadata: {} }));
    storage.create.mockImplementationOnce(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });

    await sync(virtualMcps, true);

    expect(storage.update).not.toHaveBeenCalled();
  });

  it("rethrows a create failure that was not a race", async () => {
    const { storage, virtualMcps } = fakeStorage(null);
    storage.create.mockImplementationOnce(async () => {
      throw new Error("database is down");
    });

    await expect(sync(virtualMcps, true)).rejects.toThrow("database is down");
  });
});

describe("the agent's definition at run time", () => {
  it("comes from code, whatever the stored row says", async () => {
    const { resolveEffectiveStudioPackVirtualMcp } = await import(
      "@/tools/virtual/studio-pack"
    );
    const stored = {
      id: ID,
      metadata: { instructions: "", note: "kept" },
      connections: [
        {
          connection_id: `${ORG}_self`,
          selected_tools: ["JIRA_ISSUE_GET"],
          selected_resources: null,
          selected_prompts: [],
        },
      ],
    };

    const effective = await resolveEffectiveStudioPackVirtualMcp({
      virtualMcp: stored as never,
      organizationId: ORG,
      ctx: {} as never,
    });

    expect(effective.metadata).toMatchObject({
      instructions: JIRA_CHAT_AGENT_INSTRUCTIONS,
      note: "kept",
    });
    expect(effective.connections[0]?.selected_tools).toEqual([
      ...JIRA_CHAT_AGENT_TOOLS,
    ]);
  });

  it("leaves an ordinary agent untouched", async () => {
    const { resolveEffectiveStudioPackVirtualMcp } = await import(
      "@/tools/virtual/studio-pack"
    );
    const stored = { id: "vir_other", metadata: {}, connections: [] };

    const effective = await resolveEffectiveStudioPackVirtualMcp({
      virtualMcp: stored as never,
      organizationId: ORG,
      ctx: {} as never,
    });

    expect(effective).toBe(stored as never);
  });
});
