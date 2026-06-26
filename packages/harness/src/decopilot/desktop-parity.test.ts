import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "../types";
import {
  buildDesktopToolKeysViaExistingAdapter,
  buildDesktopToolKeysViaUnifiedFactory,
} from "./desktop-parity.fixtures";
import { setDecopilotRunContext } from "./run-context";

const input = {
  threadId: "t1",
  userMessage: {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  },
  harness: {},
  workspace: { cwd: null },
  models: { thinking: { id: "gpt-4.1", title: "GPT", credentialId: "c1" } },
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
  agent: { id: "agent-1" },
  signal: new AbortController().signal,
} satisfies HarnessStreamInput;

setDecopilotRunContext(input, {
  virtualMcp: { id: "agent-1", metadata: {} },
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
});

// The sorted desktop tool-key baseline captured at the unification cutover.
// The desktop fork is deleted, so this is now a REGRESSION LOCK: any drift in
// the unified factory's desktop tool set must update this list deliberately.
// The cluster-only tools (`web_search`, `update_interests`) appear here only as
// UNAVAILABLE stubs (`includeUnavailableClusterOnlyTools` — see
// portable-built-ins): they surface to the model but throw "only available in
// cluster Decopilot" at execution, so the desktop never runs the real cluster
// path.
const DESKTOP_TOOL_KEYS_BASELINE = [
  "bash",
  "edit",
  "glob",
  "grep",
  "propose_plan",
  "read",
  "read_tool_output",
  "skill",
  "subtask",
  "todo_write",
  "update_interests",
  "user_ask",
  "web_search",
  "write",
];

describe("decopilot desktop tool-set parity", () => {
  it("unified factory yields the hardcoded desktop tool-key baseline", async () => {
    const newKeys = await buildDesktopToolKeysViaUnifiedFactory(input);
    expect(newKeys).toEqual(DESKTOP_TOOL_KEYS_BASELINE);
    // Sanity: desktop set must include the local built-ins (e.g. `read`).
    expect(newKeys).toContain("read");
    expect(newKeys).toContain("web_search");
    expect(newKeys).toContain("update_interests");
  });

  it("both parity builders drive the unified desktop assembler, exactly", async () => {
    const oldKeys = await buildDesktopToolKeysViaExistingAdapter(input);
    const newKeys = await buildDesktopToolKeysViaUnifiedFactory(input);
    expect(newKeys).toEqual(oldKeys);
    expect(newKeys).toEqual(DESKTOP_TOOL_KEYS_BASELINE);
  });
});
