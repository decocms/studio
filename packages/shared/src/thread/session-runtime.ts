/**
 * Session-runtime resolution — the ONE gate for "is this session sandbox-less
 * (Fast Preview / CMS) or sandbox-backed (coding session)?".
 *
 * Two inputs, strict precedence:
 *
 *   1. The thread's own stamp (`thread.metadata.runtime`), written once at
 *      creation by the affordance that created the thread ("Start coding
 *      session" stamps `"sandbox"`) and immutable for the thread's life.
 *   2. The project default: the Fast Preview capability gate on the vMCP —
 *      `metadata.fastPreview === true` AND a valid preview server URL
 *      (`previewServerUrl`, legacy `productionUrl`). A bare flag with no URL
 *      is inert; there is nothing to render against.
 *
 * A thread with no stamp resolves exactly as before per-thread runtimes
 * existed, so old rows need no migration. The stamp can only choose
 * `"sandbox"` into a fast-preview project meaningfully — a `"cms"` stamp on a
 * project without the capability still resolves to `"sandbox"`, because a
 * CMS session without a preview server URL has nothing to render.
 *
 * Consumers: the web surfaces (via `apps/web/src/sdk/fast-preview.ts`), the
 * sandbox-proxy claim middleware, and thread creation. Isomorphic and pure on
 * purpose — the gate must not drift between client and server.
 */

import { resolvePreviewServerUrl } from "../deco-site-production-url.ts";

/** How a session reads and writes the project: sandbox-less CMS over the
 *  decofile API, or a sandbox pod with a daemon and dev server. */
export type ThreadRuntime = "cms" | "sandbox";

export const THREAD_RUNTIMES = ["cms", "sandbox"] as const;

/** Narrow an unknown metadata value to a runtime stamp, else `null`. The
 *  thread metadata bag is open (`[key: string]: unknown`), so the read
 *  validates rather than trusts. */
export function parseThreadRuntime(value: unknown): ThreadRuntime | null {
  return value === "cms" || value === "sandbox" ? value : null;
}

export interface VmcpRuntimeMetadata {
  previewServerUrl?: string | null;
  productionUrl?: string | null;
  fastPreview?: boolean | null;
}

export interface SessionRuntime {
  /** The resolved runtime for this session. */
  runtime: ThreadRuntime;
  /** The project's Fast Preview capability gate (flag AND URL) — also the
   *  default runtime for unstamped threads (`true` ⇒ "cms"). */
  fastPreviewCapability: boolean;
  /** The URL the CMS preview renders against, or `null` when none is set. */
  previewServerUrl: string | null;
}

/**
 * The project's Fast Preview capability: the switch is on AND there is a
 * preview server to render against. A bare flag with no URL is inert.
 *
 * This is the ONE capability predicate. It answers a PROJECT question, never a
 * session one — `defaultThreadRuntime` turns it into the runtime a NEW thread
 * is stamped with, and nothing else may re-derive a session's runtime from it.
 */
export function fastPreviewCapability(
  vmcpMetadata: VmcpRuntimeMetadata | null | undefined,
): boolean {
  return (
    !!resolvePreviewServerUrl(vmcpMetadata) &&
    vmcpMetadata?.fastPreview === true
  );
}

/**
 * The runtime a NEW thread on this project is stamped with. The project flag is
 * a default, not a gate: once stamped, a thread keeps that runtime for life
 * even if the project's capability later changes.
 */
export function defaultThreadRuntime(
  vmcpMetadata: VmcpRuntimeMetadata | null | undefined,
): ThreadRuntime {
  return fastPreviewCapability(vmcpMetadata) ? "cms" : "sandbox";
}

export function resolveSessionRuntime(
  vmcpMetadata: VmcpRuntimeMetadata | null | undefined,
  threadMetadata?: { runtime?: unknown } | null,
): SessionRuntime {
  const previewServerUrl = resolvePreviewServerUrl(vmcpMetadata);
  const capability = fastPreviewCapability(vmcpMetadata);
  // A "cms" stamp without the capability collapses into the default branch.
  const stamp = parseThreadRuntime(threadMetadata?.runtime);
  const runtime: ThreadRuntime =
    stamp === "sandbox" ? "sandbox" : defaultThreadRuntime(vmcpMetadata);
  return { runtime, fastPreviewCapability: capability, previewServerUrl };
}
