/**
 * Title interceptor — taps the harness chunk stream and persists
 * harness-generated title results.
 *
 * Harnesses own title generation with their own fast model and emit a
 * transient `data-title-result` chunk. This interceptor keeps storage and
 * SSE concerns cluster-side: it swallows that internal result, persists the
 * title, invokes the thread-status callback, and writes the UI-facing
 * `data-thread-title` chunk while the stream is still open.
 */
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { MeshContext } from "@/core/mesh-context";
import type { HarnessProcessLocal } from "@/harnesses/types";
import { isTitleInputChunk, isTitleResultChunk } from "@/harnesses/title-chunk";
import { DEFAULT_THREAD_TITLE } from "./constants";

export interface TitleInterceptorDeps {
  ctx: MeshContext;
  processLocal: HarnessProcessLocal;
  currentThreadTitle: string | null | undefined;
  threadId: string;
  writer: UIMessageStreamWriter;
  onTitleUpdated?: (title: string) => void | Promise<void>;

  persistTitle?: (threadId: string, title: string) => Promise<void>;
}

export async function* interceptTitleChunks(
  source: AsyncIterable<UIMessageChunk>,
  deps: TitleInterceptorDeps,
): AsyncIterable<UIMessageChunk> {
  const persistTitleFn =
    deps.persistTitle ??
    ((threadId: string, title: string) =>
      deps.ctx.storage.threads.update(threadId, { title }).then(() => {}));

  let triggered = false;

  for await (const chunk of source) {
    if (isTitleInputChunk(chunk)) {
      console.warn(
        "[title-interceptor] harness emitted deprecated data-title-input chunk; ignoring",
      );
      continue;
    }

    if (isTitleResultChunk(chunk)) {
      if (triggered) {
        console.warn(
          "[title-interceptor] harness emitted multiple data-title-result chunks; ignoring extra",
        );
        continue;
      }
      triggered = true;

      // Gate on the request-time thread title — if the user has already
      // renamed the thread, do not persist an auto-generated replacement.
      if (deps.currentThreadTitle !== DEFAULT_THREAD_TITLE) continue;

      const title = chunk.data.title;
      if (!title) continue;

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
      continue;
    }

    yield chunk;
  }
}
