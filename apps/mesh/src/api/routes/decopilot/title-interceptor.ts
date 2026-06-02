/**
 * Title interceptor — taps the harness chunk stream and runs cluster-side
 * title generation when the harness emits a `data-title-input` chunk.
 *
 * Lifecycle:
 *  - Forwards every non-title chunk through unchanged, preserving order.
 *  - On the FIRST `data-title-input` chunk:
 *    - Swallows the chunk (does not yield it downstream).
 *    - Skips title gen if currentThreadTitle !== DEFAULT_THREAD_TITLE.
 *    - Otherwise spawns genTitle() with the cluster's pre-activated
 *      provider, registers the resulting promise via
 *      `registerPendingOp` so the outer drain waits for it, and
 *      arranges to persist + emit `data-thread-title` when it resolves.
 *  - On subsequent `data-title-input` chunks: swallows + warns (a
 *    harness emitting more than one is a contract bug, not a fatal
 *    error).
 *  - When the source iterator completes (normally or via throw), calls
 *    `handle.finish()` so the 10s post-stream grace period in
 *    genTitle's title-generation logic kicks in.
 *
 * Errors from persist/SSE/writer are logged and swallowed — title
 * failure must never break the run. genTitle itself handles abort /
 * provider error by resolving to the fallback (10-char slice) or null
 * (abort).
 *
 * Deps are injectable so the unit tests can stub genTitle/persistTitle
 * without standing up a MeshContext.
 */
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { MeshContext } from "@/core/mesh-context";
import type { HarnessProcessLocal, ModelsConfig } from "@/harnesses/types";
import type { MeshProvider } from "@/ai-providers/types";
import { createLanguageModel as realCreateLanguageModel } from "@/ai-providers/language-model";
import { genTitle as realGenTitle } from "@/harnesses/decopilot/title-generator";
import { isTitleInputChunk } from "@/harnesses/title-chunk";
import { DEFAULT_THREAD_TITLE } from "./constants";

export interface TitleInterceptorDeps {
  ctx: MeshContext;
  processLocal: HarnessProcessLocal;
  models: ModelsConfig;
  currentThreadTitle: string | null | undefined;
  threadId: string;
  writer: UIMessageStreamWriter;
  registerPendingOp: (op: Promise<void>) => void;
  registrySignal: AbortSignal;
  onTitleUpdated?: (title: string) => void | Promise<void>;

  /** Injection seams for unit tests. Defaults wire to the real impls. */
  genTitle?: typeof realGenTitle;
  persistTitle?: (threadId: string, title: string) => Promise<void>;
  createLanguageModel?: (
    provider: MeshProvider,
    selection: { id: string; provider?: string | null },
  ) => unknown;
}

export async function* interceptTitleChunks(
  source: AsyncIterable<UIMessageChunk>,
  deps: TitleInterceptorDeps,
): AsyncIterable<UIMessageChunk> {
  const genTitleFn = deps.genTitle ?? realGenTitle;
  const persistTitleFn =
    deps.persistTitle ??
    ((threadId: string, title: string) =>
      deps.ctx.storage.threads.update(threadId, { title }).then(() => {}));
  const createLanguageModelFn =
    deps.createLanguageModel ?? realCreateLanguageModel;

  let triggered = false;
  let titleHandle: ReturnType<typeof genTitleFn> | null = null;

  try {
    for await (const chunk of source) {
      if (isTitleInputChunk(chunk)) {
        if (triggered) {
          console.warn(
            "[title-interceptor] harness emitted multiple data-title-input chunks; ignoring extra",
          );
          continue;
        }
        triggered = true;

        // Gate on the request-time thread title — if the user has
        // already renamed the thread, do not run title gen at all.
        if (deps.currentThreadTitle !== DEFAULT_THREAD_TITLE) {
          continue;
        }

        const userMessage = chunk.data.userMessage;

        const provider = deps.processLocal.provider as MeshProvider | null;
        if (!provider) {
          // No cluster-side provider available (e.g. orphan recovery
          // path). Skip silently — title stays "New chat".
          continue;
        }

        const model = createLanguageModelFn(
          provider,
          deps.models.fast ?? deps.models.thinking,
        );

        titleHandle = genTitleFn({
          abortSignal: deps.registrySignal,
          model: model as never,
          userMessage,
        });

        const op = titleHandle.promise
          .then(async (title) => {
            if (!title) return;

            await persistTitleFn(deps.threadId, title).catch((err) => {
              console.error(
                "[title-interceptor] persist failed for thread",
                deps.threadId,
                err,
              );
            });

            try {
              await deps.onTitleUpdated?.(title);
            } catch (err) {
              console.error(
                "[title-interceptor] onTitleUpdated callback failed",
                err,
              );
            }

            if (!deps.processLocal.isStreamFinished()) {
              try {
                deps.writer.write({
                  type: "data-thread-title",
                  data: { title },
                  transient: true,
                } as UIMessageChunk);
              } catch (err) {
                console.error("[title-interceptor] writer.write failed", err);
              }
            }
          })
          .catch((err) => {
            console.warn("[title-interceptor] title generation failed", err);
          });

        deps.registerPendingOp(op);
        continue;
      }

      yield chunk;
    }
  } finally {
    // Trigger the post-stream grace period in genTitle so the LLM call
    // can still finish (or be aborted after 10s), matching the inline
    // behaviour the Decopilot harness used to own.
    titleHandle?.finish();
  }
}
