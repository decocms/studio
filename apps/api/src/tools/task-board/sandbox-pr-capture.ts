/**
 * Link the change request a sandbox-hosted run opens from bash.
 *
 * Claude Code and Codex run `gh pr create` inside the pod, so neither the
 * provider MCP hook nor the native loop's step scan sees it. Their tool calls
 * still stream through Studio as chunks, normalized to `bash` with the command
 * on `input.command`, so the same scan runs here. Without it the board learned
 * the PR only from the run's own branch (`pr-by-branch.ts`), which misses one
 * opened from any other branch.
 */

import type { UIMessageChunk } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { capturePrForRun, isPrCreateBashCommand } from "./run-reactions";

export async function* withSandboxPrCapture(
  chunks: AsyncIterable<UIMessageChunk>,
  ctx: StudioContext,
  threadId: string,
  capture: typeof capturePrForRun = capturePrForRun,
): AsyncIterable<UIMessageChunk> {
  const pending = new Set<string>();
  for await (const chunk of chunks) {
    if (
      chunk.type === "tool-input-available" &&
      chunk.toolName === "bash" &&
      isPrCreateBashCommand(commandOf(chunk.input))
    ) {
      pending.add(chunk.toolCallId);
    } else if (
      chunk.type === "tool-output-available" &&
      pending.delete(chunk.toolCallId)
    ) {
      void capture(ctx, chunk.output, null, threadId);
    } else if (chunk.type === "tool-output-error") {
      pending.delete(chunk.toolCallId);
    }
    yield chunk;
  }
}

function commandOf(input: unknown): string {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return "";
  }
  return typeof input.command === "string" ? input.command : "";
}
