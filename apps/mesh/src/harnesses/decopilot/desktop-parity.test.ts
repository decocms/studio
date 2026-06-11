import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "../types";
import {
  buildDesktopToolKeysViaExistingAdapter,
  buildDesktopToolKeysViaUnifiedFactory,
} from "./desktop-parity.fixtures";

const input = {
  threadId: "t1",
  runId: "r1",
  messages: [],
  workspace: { cwd: "default" },
  models: { thinking: { id: "gpt-4.1", title: "GPT", credentialId: "c1" } },
  modelSources: {
    thinking: {
      kind: "secret",
      providerId: "anthropic",
      apiKey: "sk",
      modelId: "gpt-4.1",
    },
  },
  mcpSource: {
    kind: "http",
    url: "https://studio.example/mcp/agent-1",
    headers: { Authorization: "Bearer x" },
    expiresAt: 9999999999000,
  },
  mcp: {
    url: "https://studio.example/mcp/agent-1",
    headers: {},
    expiresAt: 9999999999000,
  },
  mode: "default",
  temperature: 0.5,
  toolApprovalLevel: "auto",
  user: { id: "u1", email: "u@e.com" },
  organizationId: "org-1",
  virtualMcp: { id: "agent-1", metadata: {} },
  agent: { id: "agent-1" },
  signal: new AbortController().signal,
} satisfies HarnessStreamInput;

describe("decopilot desktop tool-set parity", () => {
  it("unified factory yields the same desktop tool keys as the deleted adapter", async () => {
    const oldKeys = await buildDesktopToolKeysViaExistingAdapter(input);
    const newKeys = await buildDesktopToolKeysViaUnifiedFactory(input);
    expect(newKeys).toEqual(oldKeys);
    // Sanity: desktop set must include the local built-ins (e.g. `read`).
    expect(oldKeys).toContain("read");
    // The cluster-only tools are present only as UNAVAILABLE stubs
    // (`includeUnavailableClusterOnlyTools` — see portable-built-ins): they
    // surface to the model but throw "only available in cluster Decopilot" at
    // execution, so the desktop never runs the real cluster path.
    expect(oldKeys).toContain("web_search");
    expect(oldKeys).toContain("update_interests");
  });
});
