import { describe, expect, test } from "bun:test";
import { InProcessSandboxClient } from "./in-process-sandbox-client";
import type { HarnessStreamInput } from "@/harnesses/lib/types";
import type { StudioContext } from "../core/studio-context";

const makeInput = (): HarnessStreamInput => ({
  threadId: "t1",
  userMessage: {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  },
  harness: {},
  workspace: { cwd: null },
  models: {
    thinking: { id: "m-thinking", title: "Thinking", credentialId: "cred-1" },
  } as unknown as HarnessStreamInput["models"],
  mcp: { url: "http://localhost/mcp", headers: {}, expiresAt: 0 },
  mode: "default",
  temperature: 0,
  toolApprovalLevel: "auto",
  user: { id: "u1", email: "u1@example.com" },
  organizationId: "org-1",
  agent: { id: "agent-1" },
  signal: new AbortController().signal,
});

const stubCtx = {} as StudioContext;

// Decopilot is hard-wired (no registry, no stub seam), so these assert the
// real factory's contract: the CLI guard fires eagerly, and dispatch is lazy —
// nothing executes until the stream is pulled.
describe("InProcessSandboxClient", () => {
  test.each(["claude-code", "codex"] as const)(
    "dispatch throws eagerly for CLI harness %s",
    (id) => {
      const client = new InProcessSandboxClient({
        ctx: stubCtx,
        harnessId: id,
      });
      expect(() => client.dispatch(makeInput())).toThrow(
        /runs cluster-hosted decopilot only/,
      );
    },
  );

  test("dispatch for decopilot returns a lazy stream without executing", () => {
    const client = new InProcessSandboxClient({
      ctx: stubCtx,
      harnessId: "decopilot",
    });
    // The real decopilot stream would throw on first pull (stub ctx, no run
    // context) — not pulling proves create()+stream() do no eager work.
    const iter = client.dispatch(makeInput());
    expect(typeof iter[Symbol.asyncIterator]).toBe("function");
  });
});
