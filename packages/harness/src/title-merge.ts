/**
 * Shared `mergeTitleResult` — interleaves a harness's main UI message stream
 * with the background title-result chunk.
 *
 * Extracted verbatim from the byte-identical copies that used to live in
 * `claude-code/index.ts` and `codex/index.ts`. Both CLI harnesses kick off a
 * background `genTitle` and need the title-result chunk woven into their main
 * stream as soon as the title resolves; this generator races the two sources,
 * yields main chunks in order, emits the title-result chunk once (or nothing
 * if the title resolved null), and `finish()`-es the handle when the main
 * stream ends first so the title's grace timer can wind down.
 *
 * Typed against a minimal `TitleHandle` so callers don't need to import
 * `genTitle`'s full return type. `ReturnType<typeof genTitle>` is a structural
 * superset of `TitleHandle` (it carries `{ promise, finish }`), so existing
 * call sites pass without a cast.
 *
 * Also exports `shouldGenerateTitle` — the producer-side auto-title gate
 * (decision D13) that every harness consults before kicking off `genTitle`.
 *
 * This module is `@/*`-free so the daemon can bundle it.
 */
import type { UIMessageChunk } from "ai";
import { makeTitleResultChunk } from "./title-chunk";
import { stringifyError } from "./stream-error";
import { DEFAULT_THREAD_TITLE } from "./thread-title";

/**
 * Producer-side auto-title gate (decision D13). Auto-title only an *unrenamed*
 * thread — one whose title still equals {@link DEFAULT_THREAD_TITLE} — and
 * NEVER a delegated subtask run. `kind` is undefined for the CLI harnesses
 * (which are never subtask producers); they pass only the title.
 *
 * Skipping here saves a model call the cluster's title interceptor would
 * otherwise discard post-hoc. The interceptor keeps its own gate as
 * defense-in-depth against a rename racing the run.
 */
export function shouldGenerateTitle(params: {
  currentThreadTitle: string | null | undefined;
  kind?: "main" | "subtask";
}): boolean {
  return (
    params.kind !== "subtask" &&
    params.currentThreadTitle === DEFAULT_THREAD_TITLE
  );
}

/** Minimal structural contract `mergeTitleResult` needs from a title handle.
 *  `genTitle` returns `{ promise, finish }` (plus possibly more), so its return
 *  type is assignable to this. */
export interface TitleHandle {
  promise: Promise<string | null>;
  finish: () => void;
}

export async function* mergeTitleResult(
  uiStream: AsyncIterable<UIMessageChunk>,
  titleHandle: TitleHandle,
): AsyncIterable<UIMessageChunk> {
  type Settled =
    | { kind: "main"; value: IteratorResult<UIMessageChunk> }
    | { kind: "title"; value: UIMessageChunk | null };

  const iter = uiStream[Symbol.asyncIterator]();
  let mainDone = false;
  let titleDone = false;
  let mainPromise: Promise<Settled> = iter
    .next()
    .then((value) => ({ kind: "main" as const, value }));
  const titlePromise: Promise<Settled> = titleHandle.promise
    .then((title) => ({
      kind: "title" as const,
      value: title ? (makeTitleResultChunk(title) as UIMessageChunk) : null,
    }))
    .catch((err) => {
      console.warn(
        "[harness:title] title generation failed",
        stringifyError(err),
      );
      return { kind: "title" as const, value: null };
    });

  try {
    while (!mainDone || !titleDone) {
      const pending: Promise<Settled>[] = [];
      if (!mainDone) pending.push(mainPromise);
      if (!titleDone) pending.push(titlePromise);

      const settled = await Promise.race(pending);
      if (settled.kind === "main") {
        if (settled.value.done) {
          mainDone = true;
          if (!titleDone) titleHandle.finish();
          continue;
        }
        yield settled.value.value;
        mainPromise = iter
          .next()
          .then((value) => ({ kind: "main" as const, value }));
        continue;
      }

      titleDone = true;
      if (settled.value) yield settled.value;
    }
  } finally {
    if (!titleDone) titleHandle.finish();
  }
}
