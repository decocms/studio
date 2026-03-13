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
  | { threadId: string; error: string }
  | { skipped: "concurrency_limit" }
  | { skipped: "creator_invalid" }
  | { skipped: "global_limit" };

// ============================================================================
// Core
// ============================================================================

export async function fireAutomation(opts: {
  automation: Automation;
  triggerId: string | null;
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

  console.log(
    `[fireAutomation] Starting for automation "${automation.name}" (${automation.id}), triggerId=${triggerId}`,
  );

  // 0. Acquire global semaphore
  const globalSlot = globalSemaphore.tryAcquire();
  if (!globalSlot) {
    console.warn(
      `[fireAutomation] SKIPPED "${automation.name}" — global concurrency limit`,
    );
    return { skipped: "global_limit" };
  }

  try {
    // 1. Verify creator is still active in the org
    const ctx = await meshContextFactory(
      automation.organization_id,
      automation.created_by,
    );
    if (!ctx) {
      console.warn(
        `[fireAutomation] SKIPPED "${automation.name}" — creator ${automation.created_by} not in org ${automation.organization_id}, deactivating`,
      );
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
    if (!threadId) {
      console.warn(
        `[fireAutomation] SKIPPED "${automation.name}" — per-automation concurrency limit (max ${config.maxConcurrentPerAutomation})`,
      );
      return { skipped: "concurrency_limit" };
    }

    console.log(
      `[fireAutomation] Acquired run slot threadId=${threadId} for "${automation.name}"`,
    );

    // 3. Build request & fire with timeout
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      config.runTimeoutMs,
    );

    let runError: string | undefined;
    try {
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
      request.abortSignal = abortController.signal;

      const result = await streamCoreFn(request, ctx, {
        runRegistry: deps.runRegistry,
        streamBuffer: undefined,
        cancelBroadcast: deps.cancelBroadcast,
      });
      await consumeStreamCore(result);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      console.error(
        `[fireAutomation] ERROR "${automation.name}" threadId=${threadId}:`,
        runError,
      );
      try {
        await storage.markRunFailed(threadId);
      } catch (_) {
        // best-effort
      }
    } finally {
      clearTimeout(timeout);
    }

    if (runError) return { threadId, error: runError };
    console.log(
      `[fireAutomation] SUCCESS "${automation.name}" threadId=${threadId}`,
    );
    return { threadId };
  } finally {
    globalSlot.release();
  }
}
