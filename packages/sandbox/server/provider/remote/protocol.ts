/**
 * Wire contract between studio and the sandbox controller. Mirrors
 * `packages/sandbox/controller-go/protocol/protocol.go` field for field, and
 * `protocol/contract_test.go` fails the Go build if either side drifts.
 *
 * The payload types these envelopes carry — `EnsureOptions`, `Repo`, `Tenant`,
 * `Workload`, `SandboxId` — are imported from `../types`, not restated here;
 * the contract test scans that file too, since they are equally the wire shape.
 *
 * The controller is control plane only. It answers WHERE a sandbox's daemon is
 * and WHAT token opens it — no request or response body is relayed through it,
 * so studio's existing daemon fetch code is unchanged and the controller never
 * has to reimplement streaming, SSE passthrough or websocket upgrade.
 */

import { z } from "zod";
import type { EnsureOptions, SandboxId } from "../types";

/** Optional `SandboxProvider` methods, declared as data instead of probed by calling. */
export const runtimeCapabilitySchema = z.enum([
  "preview",
  "lifecycle-phases",
  "warm-pool",
  "termination-reason",
  "ttl-extend",
  "capacity",
]);
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

export interface EnsureRequest {
  id: SandboxId;
  opts?: EnsureOptions;
  /** A hard constraint when set — 503 rather than a silent placement elsewhere. */
  runtime?: string;
  requires?: RuntimeCapability[];
  allowFallback?: boolean;
}

/** Where the daemon is and what opens it. Studio dials this itself. */
export interface DaemonAddress {
  url: string;
  token: string;
}

export interface EnsureResponse {
  handle: string;
  workdir: string;
  previewUrl: string | null;
  daemon: DaemonAddress;
  runtime: string;
  capabilities: RuntimeCapability[];
  /**
   * Set when the handle already existed on a different runtime than the one
   * asked for. The live sandbox is returned as-is — switching is an explicit
   * DELETE + POST, never implicit.
   */
  runtimeMismatch?: string;
}

export interface StatusResponse {
  handle: string;
  alive: boolean;
  previewUrl: string | null;
  daemon: DaemonAddress | null;
  runtime: string;
  capabilities: RuntimeCapability[];
  lastTermination: {
    reason: string;
    oomKilled: boolean;
    exitCode?: number;
    memoryLimit?: string;
  } | null;
}

export type LifetimeRequest =
  | { extendToIdleWindow: true }
  | { graceMs: number };

export interface RuntimeInfo {
  name: string;
  available: boolean;
  reason?: string;
  capacity?: { schedulable: boolean; observedAt: string };
  capabilities: RuntimeCapability[];
  priority: number;
}

export interface RuntimesResponse {
  runtimes: RuntimeInfo[];
}

export interface CapacityResponse {
  schedulable: boolean;
}

export interface AdoptResponse {
  adopted: boolean;
}

/**
 * Studio's callback for a fresh clone credential.
 *
 * Studio MUST verify that `(connectionId, cloneUrl)` belongs to a sandbox that
 * actually exists before minting. Without that check this is a credential
 * oracle: `buildCloneInfo` carries no org scope, so a caller naming an
 * arbitrary connection would get a live GitHub App token for it, across orgs.
 */
export const cloneUrlRequestSchema = z.object({
  connectionId: z.string().min(1),
  cloneUrl: z.string().min(1),
  bufferMs: z.number().int().nonnegative().optional(),
});
export type CloneUrlRequest = z.infer<typeof cloneUrlRequestSchema>;
export interface CloneUrlResponse {
  cloneUrl: string | null;
}
export const CLONE_URL_PATH = "/api/_sandbox-controller/clone-url";
