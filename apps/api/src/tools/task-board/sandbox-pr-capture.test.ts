import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { withSandboxPrCapture } from "./sandbox-pr-capture";

const ctx = {} as StudioContext;
const PR_OUTPUT =
  "https://github.com/acme/shop/pull/12\nhttps://github.com/acme/shop/pull/7#issuecomment-1\n";

async function run(chunks: UIMessageChunk[]) {
  const captured: { output: unknown; threadId?: string }[] = [];
  async function* source() {
    yield* chunks;
  }
  const seen: UIMessageChunk[] = [];
  for await (const chunk of withSandboxPrCapture(
    source(),
    ctx,
    "thrd_1",
    async (_ctx, output, _connectionId, threadId) => {
      captured.push({ output, threadId });
    },
  )) {
    seen.push(chunk);
  }
  return { captured, seen };
}

function bash(toolCallId: string, command: unknown): UIMessageChunk {
  return {
    type: "tool-input-available",
    toolCallId,
    toolName: "bash",
    input: { command },
  };
}

function output(toolCallId: string, value: unknown): UIMessageChunk {
  return { type: "tool-output-available", toolCallId, output: value };
}

describe("withSandboxPrCapture", () => {
  it("captures the output of a bash call that opens a pull request", async () => {
    const chunks = [
      bash("a", "git push -u origin task-1 && gh pr create --base main --fill"),
      output("a", PR_OUTPUT),
    ];
    const { captured, seen } = await run(chunks);
    expect(captured).toEqual([{ output: PR_OUTPUT, threadId: "thrd_1" }]);
    expect(seen).toEqual(chunks);
  });

  it("ignores other bash calls and non-bash tools", async () => {
    const { captured } = await run([
      bash("a", "gh pr view 7"),
      output("a", PR_OUTPUT),
      {
        type: "tool-input-available",
        toolCallId: "b",
        toolName: "read",
        input: { command: "gh pr create" },
      },
      output("b", PR_OUTPUT),
      bash("c", 42),
      output("c", PR_OUTPUT),
    ]);
    expect(captured).toEqual([]);
  });

  it("does not capture a failed call or a repeated result", async () => {
    const { captured } = await run([
      bash("a", "gh pr create --fill"),
      { type: "tool-output-error", toolCallId: "a", errorText: "denied" },
      output("a", PR_OUTPUT),
      bash("b", "gh pr create --fill"),
      output("b", PR_OUTPUT),
      output("b", PR_OUTPUT),
    ]);
    expect(captured).toEqual([{ output: PR_OUTPUT, threadId: "thrd_1" }]);
  });
});
