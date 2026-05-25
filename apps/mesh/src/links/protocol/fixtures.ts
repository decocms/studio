import type { DispatchSSEEvent, HarnessStreamInputWire } from "./schemas";

/**
 * Shared by cluster `remoteDispatch` tests AND daemon dispatch tests.
 * If one side drifts, CI breaks on the other. Drop fixtures
 * conservatively — every new one is wire-contract surface area.
 */

export const FIXTURE_MINIMAL_INPUT: HarnessStreamInputWire = {
  threadId: "thr-fixture",
  runId: "run-fixture",
  taskId: "thr-fixture",
  messages: [],
  models: {
    credentialId: "cred-fixture",
    thinking: { id: "claude-code:opus", title: "Opus" },
  },
  mcp: {
    url: "https://mesh.example.com/mcp/virtual-mcp/agent-fixture",
    headers: { Authorization: "Bearer fixture-token" },
    expiresAt: 9999999999000,
  },
  mode: "default",
  temperature: 0.7,
  toolApprovalLevel: "auto",
  user: { id: "user-fixture", email: "fixture@example.com" },
  organizationId: "org-fixture",
  virtualMcp: { id: "agent-fixture" },
  agent: { id: "agent-fixture" },
};

export const FIXTURE_SSE_HAPPY_PATH: readonly DispatchSSEEvent[] = [
  { type: "ui-message-chunk", chunk: { type: "start", id: "msg-1" } },
  {
    type: "ui-message-chunk",
    chunk: { type: "text-delta", id: "msg-1", delta: "Hello" },
  },
  {
    type: "ui-message-chunk",
    chunk: { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } },
  },
  { type: "ui-message-chunk", chunk: { type: "finish", finishReason: "stop" } },
  { type: "done" },
] as const;

export const FIXTURE_SSE_HARNESS_CRASH: readonly DispatchSSEEvent[] = [
  { type: "ui-message-chunk", chunk: { type: "start", id: "msg-1" } },
  {
    type: "error",
    code: "harness_crashed",
    message: "claude exited with code 137",
  },
  { type: "done" },
] as const;
