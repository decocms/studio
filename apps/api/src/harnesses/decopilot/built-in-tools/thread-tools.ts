/**
 * Thread search built-ins
 *
 * Exposes the org's read-only thread tools (search/list, get, messages) to the
 * Super Agent as always-available built-ins, so it can recall past
 * conversations without depending on the passthrough MCP allowlist.
 *
 * Imported from the concrete tool files to keep this built-in set explicit.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { COLLECTION_THREADS_LIST } from "@/tools/thread/list";
import { COLLECTION_THREADS_GET } from "@/tools/thread/get";
import { COLLECTION_THREAD_MESSAGES_LIST } from "@/tools/thread/list-messages";

export function createThreadTools(ctx: StudioContext): ToolSet {
  return {
    search_threads: tool({
      description: COLLECTION_THREADS_LIST.description,
      inputSchema: zodSchema(COLLECTION_THREADS_LIST.inputSchema),
      execute: (input) => COLLECTION_THREADS_LIST.execute(input, ctx),
    }),
    get_thread: tool({
      description: COLLECTION_THREADS_GET.description,
      inputSchema: zodSchema(COLLECTION_THREADS_GET.inputSchema),
      execute: (input) => COLLECTION_THREADS_GET.execute(input, ctx),
    }),
    list_thread_messages: tool({
      description: COLLECTION_THREAD_MESSAGES_LIST.description,
      inputSchema: zodSchema(COLLECTION_THREAD_MESSAGES_LIST.inputSchema),
      execute: (input) => COLLECTION_THREAD_MESSAGES_LIST.execute(input, ctx),
    }),
  };
}
