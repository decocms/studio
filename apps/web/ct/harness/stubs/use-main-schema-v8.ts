/**
 * CT stub for `@/hooks/use-main-schema-v8`.
 *
 * The real hook asks the server for main's schema answer through
 * `useProjectContext()`, which this harness doesn't mount. Field specs cover
 * the editor as v7 sites see it, so main reads as v7 here.
 */
import type { MainSchemaAnswer } from "@/hooks/use-main-schema-v8";

export function useMainSchemaV8(
  _virtualMcpId: string | null | undefined,
): MainSchemaAnswer {
  return "v7";
}
