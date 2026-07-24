import type { HarnessStreamInputWire } from "./schemas";

/**
 * Shared by the daemon dispatch tests (and any other side of the dispatch wire
 * contract). If one side drifts, CI breaks on the other. Drop fixtures
 * conservatively — every new one is wire-contract surface area.
 */

export const FIXTURE_MINIMAL_INPUT: HarnessStreamInputWire = {
  threadId: "thr-fixture",
  userMessage: {
    id: "msg-fixture",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  },
  harness: {},
  workspace: { cwd: null },
  models: {
    thinking: {
      id: "claude-code:opus",
      title: "Opus",
      credentialId: "cred-fixture",
    },
  },
  mcp: {
    url: "https://studio.example.com/mcp/virtual-mcp/agent-fixture",
    headers: { Authorization: "Bearer fixture-token" },
    expiresAt: 9999999999000,
  },
  mode: "default",
  temperature: 0.7,
  toolApprovalLevel: "auto",
  user: { id: "user-fixture", email: "fixture@example.com" },
  organizationId: "org-fixture",
  agent: { id: "agent-fixture" },
};
