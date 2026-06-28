import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { InProcessSandboxClient } from "./in-process-sandbox-client";
import {
  registerHarnessFactory,
  resetRegistryForTests,
} from "@decocms/harness/registry";
import type {
  HarnessFactory,
  HarnessStreamInput,
} from "@decocms/harness/types";
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

describe("InProcessSandboxClient", () => {
  test("dispatch yields the harness chunks unchanged", async () => {
    resetRegistryForTests();
    const chunks: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      { type: "text-delta", delta: "hi" } as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    let capturedInput: HarnessStreamInput | undefined;
    let capturedCtx: unknown;
    const factory: HarnessFactory = {
      id: "decopilot",
      create(ctx) {
        capturedCtx = ctx;
        return {
          id: "decopilot",
          async *stream(input) {
            capturedInput = input;
            for (const c of chunks) yield c;
          },
        };
      },
    };
    registerHarnessFactory(factory);

    const client = new InProcessSandboxClient({
      ctx: stubCtx,
      harnessId: "decopilot",
    });
    const input = makeInput();
    const out: UIMessageChunk[] = [];
    for await (const c of client.dispatch(input)) out.push(c);

    expect(out).toEqual(chunks);
    expect(capturedInput).toBe(input); // input passed through verbatim
    expect(capturedCtx).toBe(stubCtx); // ctx forwarded to factory.create
  });

  test("dispatch throws for an unregistered harness id (same as localDispatch)", async () => {
    resetRegistryForTests();
    const client = new InProcessSandboxClient({
      ctx: stubCtx,
      harnessId: "decopilot",
    });
    await expect(async () => {
      for await (const _ of client.dispatch(makeInput())) {
        /* drain */
      }
    }).toThrow(/No harness factory registered for id "decopilot"/);
  });
});
