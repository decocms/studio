/**
 * Auto-title for sandbox-hosted runs. Decopilot titles a chat inside its own
 * loop; a sandbox harness has no such step, so Studio generates the title
 * beside the run and splices the same `data-title-result` chunk into its
 * stream, where the projector persists it and the live tail announces it.
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { UIMessageChunk } from "ai";
import { createProviderFromSecret } from "@/harnesses/lib/decopilot/provider-from-secret";
import { createLanguageModel } from "@/harnesses/lib/decopilot/studio-provider";
import { makeTitleResultChunk } from "@/harnesses/lib/title-chunk";
import { genTitle } from "@/harnesses/lib/title-generator";
import { shouldGenerateTitle } from "@/harnesses/lib/title-merge";
import type {
  DecopilotSecretModelSource,
  ModelSelection,
} from "@/harnesses/lib/types";

export interface TitleModelSlot {
  selection: ModelSelection;
  source: DecopilotSecretModelSource;
}

export function withRunTitle(
  chunks: AsyncIterable<UIMessageChunk>,
  args: {
    currentThreadTitle: string | null | undefined;
    isSubagent: boolean;
    userText: string;
    /** Fast first; the first slot that builds a usable model wins. */
    slots: Array<TitleModelSlot | undefined>;
    signal: AbortSignal;
  },
): AsyncIterable<UIMessageChunk> {
  if (
    !shouldGenerateTitle({
      currentThreadTitle: args.currentThreadTitle,
      kind: args.isSubagent ? "subtask" : "main",
    })
  ) {
    return chunks;
  }
  const seen = new Set<string>();
  const models: Array<() => LanguageModelV4> = [];
  for (const slot of args.slots) {
    if (!slot || seen.has(slot.selection.id)) continue;
    seen.add(slot.selection.id);
    models.push(
      () =>
        createLanguageModel(
          createProviderFromSecret(slot.source),
          slot.selection,
        ) as LanguageModelV4,
    );
  }
  const handle = genTitle({
    abortSignal: args.signal,
    models,
    userMessage: args.userText,
  });
  return mergeTitle(chunks, handle);
}

async function* mergeTitle(
  chunks: AsyncIterable<UIMessageChunk>,
  title: ReturnType<typeof genTitle>,
): AsyncIterable<UIMessageChunk> {
  const iterator = chunks[Symbol.asyncIterator]();
  let pendingTitle: Promise<{ title: string | null }> | null =
    title.promise.then((value) => ({ title: value }));
  let next = iterator.next();
  try {
    while (true) {
      const step = pendingTitle
        ? await Promise.race([next, pendingTitle])
        : await next;
      if ("title" in step) {
        pendingTitle = null;
        if (step.title)
          yield makeTitleResultChunk(step.title) as UIMessageChunk;
        continue;
      }
      if (step.done) break;
      yield step.value;
      next = iterator.next();
    }
    if (pendingTitle) {
      title.finish();
      const { title: late } = await pendingTitle;
      if (late) yield makeTitleResultChunk(late) as UIMessageChunk;
    }
  } finally {
    await iterator.return?.();
  }
}
