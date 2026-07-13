/**
 * E2E: agent system prompt linked to an org-fs file
 * (`metadata.instructionsFile`).
 *
 * Contract under test:
 *   1. The agent's served MCP instructions come from the linked file, not
 *      the inline `metadata.instructions` mirror.
 *   2. An instructions edit through COLLECTION_VIRTUAL_MCP_UPDATE writes
 *      through to the file.
 *   3. An external file edit (PUT over the fs routes) wins at runtime with
 *      no row update — the "synced" half of the feature.
 *   4. An update that does NOT change the prompt (e.g. a title autosave
 *      echoing the stale mirror) must NOT clobber the external file edit.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";
import type { APIRequestContext } from "@playwright/test";

const FILE_PATH = "prompts/agent-prompt.md";

async function readPromptFile(
  ctx: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const res = await ctx.get(
    `/api/${orgSlug}/fs/home/read?path=${encodeURIComponent(FILE_PATH)}`,
  );
  expect(res.ok(), `fs read: HTTP ${res.status()}`).toBe(true);
  return res.text();
}

async function writePromptFile(
  ctx: APIRequestContext,
  orgSlug: string,
  body: string,
): Promise<void> {
  const res = await ctx.put(
    `/api/${orgSlug}/fs/home/file?path=${encodeURIComponent(FILE_PATH)}`,
    { headers: { "content-type": "text/markdown" }, data: body },
  );
  expect(res.ok(), `fs write: HTTP ${res.status()}`).toBe(true);
}

/** MCP initialize against the agent's endpoint; returns served instructions. */
async function agentInstructions(
  ctx: APIRequestContext,
  orgSlug: string,
  agentId: string,
): Promise<string> {
  const res = await ctx.post(`/api/${orgSlug}/mcp/virtual-mcp/${agentId}`, {
    headers: { Accept: "application/json, text/event-stream" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1.0.0" },
      },
    },
  });
  expect(res.ok(), `initialize: HTTP ${res.status()}`).toBe(true);
  const envelope = (await res.json()) as {
    result?: { instructions?: string };
    error?: { message: string };
  };
  expect(envelope.error, envelope.error?.message).toBeUndefined();
  return envelope.result?.instructions ?? "";
}

test.describe("agent prompt linked to an org-fs file", () => {
  test("syncs from the file, writes through, and survives stale mirrors", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    const org = user.orgSlug;

    await writePromptFile(ctx, org, "You are a pirate.");

    const created = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Prompt-from-file agent",
          connections: [],
          metadata: {
            instructions: "inline seed (stale mirror)",
            instructionsFile: { volume: "home", path: FILE_PATH },
          },
        },
      },
    );
    const agentId = created.item.id;
    expect(agentId).toBeTruthy();

    // 1. Runtime serves the file content, not the inline mirror.
    const served = await agentInstructions(ctx, org, agentId);
    expect(served).toContain("You are a pirate.");
    expect(served).not.toContain("inline seed");

    // 2. A prompt edit via the update tool writes through to the file.
    await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_UPDATE", {
      id: agentId,
      data: { metadata: { instructions: "You are an accountant." } },
    });
    expect(await readPromptFile(ctx, org)).toBe("You are an accountant.");
    expect(await agentInstructions(ctx, org, agentId)).toContain(
      "You are an accountant.",
    );

    // 3. An external file edit wins at runtime with no row update.
    await writePromptFile(ctx, org, "External edit wins.");
    expect(await agentInstructions(ctx, org, agentId)).toContain(
      "External edit wins.",
    );

    // 4. A no-prompt-change update (title autosave echoing the now-stale
    //    mirror) must NOT clobber the external edit.
    await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_UPDATE", {
      id: agentId,
      data: {
        title: "Renamed agent",
        metadata: { instructions: "You are an accountant." },
      },
    });
    expect(await readPromptFile(ctx, org)).toBe("External edit wins.");

    await ctx.dispose();
  });
});
