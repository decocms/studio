/**
 * createAgentTools — the Super Agent's only route to agent CRUD (it aggregates
 * no connections), so the registered names are the contract the prompt calls by
 * name. Kept identical to the retired Agent Manager's `selectedTools`.
 */

import { describe, expect, test } from "bun:test";
import { createAgentTools } from "./agent-tools";

describe("createAgentTools", () => {
  test("registers the retired Agent Manager's toolset under its raw names", () => {
    // ctx is only read inside execute(), never during construction.
    const tools = createAgentTools({} as never);

    expect(Object.keys(tools).sort()).toEqual([
      "COLLECTION_CONNECTIONS_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_VIRTUAL_MCP_CREATE",
      "COLLECTION_VIRTUAL_MCP_DELETE",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_UPDATE",
      "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
      "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
      "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
    ]);
  });

  test("grants no connection writes — the Agent Manager could not create one either", () => {
    const tools = createAgentTools({} as never);
    expect(tools).not.toHaveProperty("COLLECTION_CONNECTIONS_CREATE");
    expect(tools).not.toHaveProperty("COLLECTION_CONNECTIONS_UPDATE");
    expect(tools).not.toHaveProperty("COLLECTION_CONNECTIONS_DELETE");
  });
});
