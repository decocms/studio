import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  registerHarnessFactory,
  resetRegistryForTests,
} from "@decocms/harness/registry";
import type {
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "@decocms/harness/types";
import type { StudioContext } from "../core/studio-context";
import { localDispatch } from "./local-dispatch";

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

describe("localDispatch", () => {
  test("throws when harness id is not registered", async () => {
    resetRegistryForTests();
    await expect(async () => {
      const iter = localDispatch("decopilot", makeInput(), stubCtx);
      for await (const _ of iter) {
        /* drain */
      }
    }).toThrow(/No harness factory registered for id "decopilot"/);
  });

  test("delegates to factory.create(ctx).stream(input)", async () => {
    resetRegistryForTests();
    const chunks: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    let capturedCtx: HarnessContext | undefined;
    const factory: HarnessFactory = {
      id: "decopilot",
      create(ctx) {
        capturedCtx = ctx;
        return {
          id: "decopilot",
          async *stream() {
            for (const c of chunks) yield c;
          },
        };
      },
    };
    registerHarnessFactory(factory);
    const out: UIMessageChunk[] = [];
    for await (const c of localDispatch("decopilot", makeInput(), stubCtx)) {
      out.push(c);
    }
    expect(out).toEqual(chunks);
    expect(capturedCtx).toBe(stubCtx);
  });
});
