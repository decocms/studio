/**
 * Session runtime — "is this session sandbox-less (CMS) or sandbox-backed
 * (a coding session)?".
 *
 * A thread's runtime is a FACT ABOUT THE THREAD, written once at creation
 * (`COLLECTION_THREADS_CREATE` always stamps `metadata.runtime`) and immutable
 * for its life. `readThreadRuntime` reads that stamp; nothing re-derives it
 * from ambient state — not from a branch, not from whether a sandbox handle
 * happens to be recorded, not from the project's current flag.
 *
 * The project's Fast Preview capability (`fastPreviewCapability`: the flag AND
 * a valid preview server URL) is the DEFAULT a new thread is stamped with, and
 * nothing else. Flipping it later cannot move a session that already exists.
 *
 * The one place a stamp can be absent is a row written before the stamp
 * existed. Those fall back to the project default here, and the sandbox-proxy
 * claim additionally probes for a live pod before answering (see
 * `resolveVmClaim`), because a legacy coding session must not be re-read as CMS
 * while its pod is still up.
 *
 * Consumers: the web surfaces (`useSessionRuntime`), the sandbox-proxy claim
 * middleware, and thread creation. Isomorphic and pure on purpose — the answer
 * must not drift between client and server.
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

/**
 * THE session's runtime. The thread's stamp decides, full stop; the project
 * default answers only for a row written before stamps existed.
 *
 * The thread argument is first and required so a caller that has no thread in
 * hand cannot silently ask this question about a project instead.
 */
export function readThreadRuntime(
  threadMetadata: { runtime?: unknown } | null | undefined,
  vmcpMetadata: VmcpRuntimeMetadata | null | undefined,
): ThreadRuntime {
  return (
    parseThreadRuntime(threadMetadata?.runtime) ??
    defaultThreadRuntime(vmcpMetadata)
  );
}
