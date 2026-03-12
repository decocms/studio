/**
 * Fire Automation
 *
 * Shared function used by both the cron worker and the event trigger engine
 * to execute a single automation run. Handles:
 *
 * - Global concurrency limiting (Semaphore)
 * - Creator validation (deactivates if creator left org)
 * - Per-automation concurrency check (tryAcquireRunSlot)
 * - Building the stream request and draining the result
 * - Timeout enforcement via AbortController
 */

import type {
  StreamCoreInput,
  StreamCoreDeps,
} from "@/api/routes/decopilot/stream-core";
import { consumeStreamCore } from "@/api/routes/decopilot/stream-core";
import type { MeshContext } from "@/core/mesh-context";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation } from "@/storage/types";
import { buildStreamRequest } from "./build-stream-request";
import type { Semaphore } from "./semaphore";

// ============================================================================
// Types
// ============================================================================

export type StreamCoreFn = (
  input: StreamCoreInput,
  ctx: MeshContext,
  deps: StreamCoreDeps,
) => Promise<{ threadId: string; stream: ReadableStream }>;

export type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

export interface FireAutomationConfig {
  maxConcurrentPerAutomation: number;
  runTimeoutMs: number;
}

export type FireAutomationResult =
  | { threadId: string }
  | { skipped: "concurrency_limit" }
  | { skipped: "creator_invalid" }
  | { skipped: "global_limit" };

// ============================================================================
// Core
// ============================================================================

export async function fireAutomation(opts: {
  automation: Automation;
  triggerId: string;
  contextMessages?: Array<{ role: string; content: string }>;
  storage: AutomationsStorage;
  streamCoreFn: StreamCoreFn;
  meshContextFactory: MeshContextFactory;
  config: FireAutomationConfig;
  globalSemaphore: Semaphore;
  deps: Pick<StreamCoreDeps, "runRegistry" | "cancelBroadcast">;
}): Promise<FireAutomationResult> {
  const {
    automation,
    triggerId,
    contextMessages,
    storage,
    streamCoreFn,
    meshContextFactory,
    config,
    globalSemaphore,
    deps,
  } = opts;

  // 0. Acquire global semaphore
  const globalSlot = globalSemaphore.tryAcquire();
  if (!globalSlot) return { skipped: "global_limit" };

  try {
    // 1. Verify creator is still active in the org
    const ctx = await meshContextFactory(
      automation.organization_id,
      automation.created_by,
    );
    if (!ctx) {
      // Creator no longer valid — deactivate automation
      await storage.deactivateAutomation(automation.id);
      return { skipped: "creator_invalid" };
    }

    // 2. Atomic concurrency check
    const threadId = await storage.tryAcquireRunSlot(
      automation.id,
      triggerId,
      config.maxConcurrentPerAutomation,
    );
    if (!threadId) return { skipped: "concurrency_limit" };

    // 3. Build request
    const request = buildStreamRequest(automation, triggerId, threadId);
    if (contextMessages) {
      request.messages = [
        ...request.messages,
        ...contextMessages.map((m) => ({
          id: crypto.randomUUID(),
          role: m.role as "user" | "assistant" | "system",
          parts: [{ type: "text" as const, text: m.content }],
        })),
      ];
    }

    // 4. Fire with timeout
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      config.runTimeoutMs,
    );
    request.abortSignal = abortController.signal;

    try {
      const result = await streamCoreFn(request, ctx, {
        runRegistry: deps.runRegistry,
        streamBuffer: undefined,
        cancelBroadcast: deps.cancelBroadcast,
      });
      await consumeStreamCore(result);
    } catch (err) {
      console.error(
        `[Automation] Run failed for automation ${automation.id}:`,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    return { threadId };
  } finally {
    globalSlot.release();
  }
}
