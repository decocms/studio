/** Hosted Decopilot's producer-side auto-title gate. */
import { DEFAULT_THREAD_TITLE } from "./thread-title";

/**
 * Producer-side auto-title gate (decision D13). Auto-title only an *unrenamed*
 * thread — one whose title still equals {@link DEFAULT_THREAD_TITLE} — and
 * NEVER a delegated subtask run.
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
