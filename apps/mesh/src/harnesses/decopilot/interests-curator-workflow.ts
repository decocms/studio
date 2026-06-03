/**
 * Interests Curator — DBOS workflow + debouncer.
 *
 * Scheduling/throttling for the interest curator. `scheduleInterestCuration`
 * is called at the end of each agent run; the `Debouncer` delays the actual
 * curation until ~1 minute after the user's LAST activity (so we curate once
 * the conversation has gone idle) and collapses bursts — even across many
 * threads — into a single run per user.
 *
 * The workflow body runs in a step that rebuilds a `MeshContext` via the
 * boot-wired factory (so it works in a later/other process), resolves the
 * org's fast model, reads the most recent thread, and runs the curator.
 *
 * Runtime deps are wired by app boot via `setInterestCuratorRuntime` BEFORE
 * `DBOS.launch()`. The workflow is registered at import time so the recovery
 * executor can replay it after a crash.
 */

import { DBOS, Debouncer } from "@dbos-inc/dbos-sdk";
import type { ModelMessage } from "ai";
import type { MeshContext } from "@/core/mesh-context";
import { resolveTier } from "@/core/resolve-tier";
import { createLanguageModel } from "@/ai-providers/language-model";
import { buildCuratorTranscript, curateInterests } from "./interests-curator";

/** Delay after the last trigger before curating — long enough to assume the
 *  thread has gone idle. */
const DEBOUNCE_PERIOD_MS = 60_000;
/** Max wait since the first trigger, so a continuously-active user still gets
 *  curated periodically. */
const DEBOUNCE_TIMEOUT_MS = 10 * 60_000;
/** How many recent messages of the latest thread feed the transcript. */
const MESSAGES_PER_THREAD = 20;
/** Skip threads too thin to have revealed a durable interest. */
const MIN_USER_MESSAGES = 2;

export type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

interface InterestCuratorRuntime {
  meshContextFactory: MeshContextFactory;
}

let runtime: InterestCuratorRuntime | null = null;

export function setInterestCuratorRuntime(rt: InterestCuratorRuntime): void {
  runtime = rt;
}

interface CurateInput {
  orgId: string;
  userId: string;
  /** The thread whose activity triggered this curation. */
  threadId: string;
}

async function curationStep(input: CurateInput): Promise<void> {
  if (!runtime || !input.threadId) return;
  const ctx = await runtime.meshContextFactory(input.orgId, input.userId);
  if (!ctx) return;

  const { messages } = await ctx.storage.threads.listMessages(input.threadId, {
    limit: MESSAGES_PER_THREAD,
    sort: "asc",
  });
  // Cheap gate: don't spend a model call on a barely-started thread.
  if (messages.filter((m) => m.role === "user").length < MIN_USER_MESSAGES) {
    return;
  }
  const transcript = buildCuratorTranscript(
    messages.map((m) => ({
      role: m.role,
      content: m.parts,
    })) as ModelMessage[],
  );
  if (!transcript.trim()) return;

  const resolved = await resolveTier(ctx, "fast");
  const provider = await ctx.aiProviders.activate(
    resolved.credentialId,
    input.orgId,
  );
  const model = createLanguageModel(provider, {
    id: resolved.modelId,
    capabilities: { reasoning: false },
  });

  await curateInterests({
    model: model as never,
    orgId: input.orgId,
    userId: input.userId,
    storage: ctx.storage.interests,
    transcript,
  });
}

async function curateInterestsWorkflowFn(input: CurateInput): Promise<void> {
  // Non-retriable: a missed curation is harmless and self-heals on the next
  // run, so we never want a stuck retry pinning resources.
  await DBOS.runStep(() => curationStep(input), {
    name: "curateInterests",
    retriesAllowed: false,
  });
}

const curateInterestsWorkflow = DBOS.registerWorkflow(
  curateInterestsWorkflowFn,
  { name: "curateInterestsWorkflow" },
);

const debouncer = new Debouncer({
  workflow: curateInterestsWorkflow,
  debounceTimeoutMs: DEBOUNCE_TIMEOUT_MS,
});

/**
 * Schedule (debounced) interest curation for a user. Fire-and-forget and
 * safe to call when DBOS isn't launched (tests) — failures are swallowed.
 */
export async function scheduleInterestCuration(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  try {
    await debouncer.debounce(`${orgId}:${userId}`, DEBOUNCE_PERIOD_MS, {
      orgId,
      userId,
      threadId,
    });
  } catch (err) {
    console.warn(
      "[decopilot:interests] failed to schedule curation:",
      (err as Error).message,
    );
  }
}
