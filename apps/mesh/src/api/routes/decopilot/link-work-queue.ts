/**
 * JetStream WorkQueue for link pull-transport (spec §3.2).
 *
 * Stream: LINK_WORK_QUEUE, subjects link.work.>, WorkQueue retention,
 * Memory storage. One subject per user (`link.work.<userSub>`).
 *
 * Work items are published idempotently keyed by `runId` (L1). A pod
 * acks each message immediately upon handing it to the HTTP response
 * (ACK-ON-DELIVERY). Redelivery-on-desktop-death is deferred to the
 * progress-staleness sweeper (a later phase) — this phase is best-effort.
 */
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type Consumer,
  type JetStreamClient,
  type JetStreamManager,
} from "nats";
import { z } from "zod";
import type { MessagesRef } from "@/harnesses/offload-messages";

const STREAM_NAME = "LINK_WORK_QUEUE";
const SUBJECT_PREFIX = "link.work";

function assertSafeSubjectToken(id: string): void {
  if (!id.length) throw new Error("Invalid NATS subject token");
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

export function buildWorkSubject(userSub: string): string {
  assertSafeSubjectToken(userSub);
  return `${SUBJECT_PREFIX}.${userSub}`;
}

export function buildConsumerName(userSub: string): string {
  assertSafeSubjectToken(userSub);
  // NATS consumer names may not contain dots
  return `link-work-${userSub.replace(/\./g, "-")}`;
}

/**
 * Repo reference for spawning a sandbox cold. Mirrors `RepoRef` from
 * `user-desktop-provider.ts` (the daemon's `EnsureSandboxInput.repo`).
 * The `cloneUrl` is resolved cluster-side (baking in the OAuth token) so
 * the daemon can clone without vault access.
 */
const workItemRepoSchema = z.object({
  cloneUrl: z.string(),
  branch: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
});

/**
 * Workload config forwarded to the daemon's `EnsureSandboxInput.workload`.
 * Mirrors `Workload` from `user-desktop-provider.ts`.
 */
const workItemWorkloadSchema = z.object({
  runtime: z.enum(["node", "bun", "deno"]),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]),
  devPort: z.number().optional(),
  packageManagerPath: z.string().optional(),
});

/**
 * Sandbox provisioning config carried on the work item so the pull-transport
 * daemon can spawn a sandbox cold without a prior WS-path ensure. Mirrors
 * `EnsureSandboxInput` from `user-desktop-provider.ts`, minus `handle` which
 * is derived by the daemon via `deriveHandle(item)`.
 *
 * Optional — absent for non-CLI harnesses or when the sandbox config could
 * not be resolved at dispatch time (back-compat: daemons that already have
 * a running sandbox for the handle still succeed via the cache-hit path).
 */
const workItemSandboxSchema = z.object({
  /** The stable sandbox handle — `computeHandle(sandboxId, branch)`. */
  handle: z.string(),
  repo: workItemRepoSchema.optional(),
  workload: workItemWorkloadSchema.optional(),
  /**
   * Message-offload SSRF allowlist. Derived cluster-side from the object-
   * storage config (never a request frame). Empty = daemon fails closed.
   */
  offloadAllowedHosts: z.array(z.string()).optional(),
  /** Allow http:// loopback offload refs (dev MinIO). */
  offloadAllowSameHostDev: z.boolean().optional(),
});

export type WorkItemSandbox = z.infer<typeof workItemSandboxSchema>;

export const workItemSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  orgId: z.string(),
  userId: z.string(),
  runFenceToken: z.string(),
  /**
   * The full HarnessStreamInputWire, opaque here — validated by the
   * daemon against harnessStreamInputSchema on receipt.
   */
  harnessInput: z.record(z.string(), z.unknown()),
  /**
   * Sandbox provisioning config. Present for CLI harnesses (claude-code,
   * codex) dispatched to a user-desktop target so the daemon can spawn the
   * sandbox cold without a prior WS-path ensure.
   *
   * Optional for back-compat: absent on non-CLI harnesses or if resolution
   * failed. Daemons MUST fall back to `ensureSandbox({ handle })` when this
   * field is absent (existing cache-hit path).
   */
  sandbox: workItemSandboxSchema.optional(),
  /**
   * Organization slug for the ingest URL path segment. Carried here so
   * the daemon doesn't need to resolve it from `orgId` (UUID) without DB
   * access. When absent, the daemon falls back to `DECO_ORG_SLUG` env var.
   */
  orgSlug: z.string().optional(),
  /**
   * Object-storage ref for the offloaded `harnessInput.messages` array.
   * Present when the encoded harnessInput exceeded the NATS `MAX_PUBLISH_BYTES`
   * budget — `harnessInput.messages` is then `[]` inline and the real messages
   * are at the presigned URL. The daemon forwards this ref verbatim in the
   * `/_sandbox/dispatch` POST body; the sandbox daemon re-inflates from it
   * (same flow as the WS path's `remoteDispatch` offload).
   *
   * Optional for back-compat: absent on small conversations (no offload needed).
   */
  messagesRef: z
    .object({
      url: z.string(),
      bytes: z.number(),
      sha256: z.string(),
    })
    .optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
export type { MessagesRef };

const encoder = new TextEncoder();

export interface LinkWorkQueueOptions {
  getJetStreamManager: () => Promise<JetStreamManager | null>;
  getJetStream: () => JetStreamClient | null;
}

export class LinkWorkQueue {
  private jsm: JetStreamManager | null = null;
  private js: JetStreamClient | null = null;

  constructor(private readonly options: LinkWorkQueueOptions) {}

  async init(): Promise<void> {
    const jsm = await this.options.getJetStreamManager();
    if (!jsm) return; // NATS not ready — work queue disabled
    this.jsm = jsm;
    this.js = this.options.getJetStream();

    const config = {
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      storage: StorageType.Memory,
      // nats.js v2 uses Workqueue (not WorkQueue) — verified against
      // node_modules/.bun/nats@2.29.3/.../jsapi_types.d.ts line 329
      retention: RetentionPolicy.Workqueue,
      discard: DiscardPolicy.Old,
      // Cap per-user backlog to prevent unbounded growth; a crashed daemon
      // will accumulate at most max_msgs_per_subject unacked items before
      // Old-discard evicts the oldest.
      max_msgs_per_subject: 1_000,
      num_replicas: 1,
    };

    try {
      await jsm.streams.info(STREAM_NAME);
      await jsm.streams.update(STREAM_NAME, config);
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("stream not found");
      if (isNotFound) {
        await jsm.streams.add(config);
      } else {
        throw err;
      }
    }
  }

  /**
   * Publish a work item idempotently keyed by runId (L1).
   * If NATS is unavailable, logs a warning and returns — the gate handles
   * absence by failing the run (a later phase can add a Postgres fallback).
   */
  async publish(userSub: string, item: WorkItem): Promise<void> {
    if (!this.js) {
      console.warn(
        "[LinkWorkQueue] JetStream not available — cannot publish work item",
        { runId: item.runId },
      );
      return;
    }
    const subject = buildWorkSubject(userSub);
    const data = encoder.encode(JSON.stringify(item));
    await this.js.publish(subject, data, { msgID: item.runId });
  }

  /**
   * Create or re-attach to a named durable pull consumer for `userSub`.
   * The consumer is durable so it persists across long-poll reconnects.
   * Returns null if JetStream is unavailable.
   *
   * API note: `js.consumers.get()` returns a `Promise<Consumer>` in
   * nats.js v2 (the new Consumer API introduced in 2.x). The plan's
   * snippet used `ReturnType<JetStreamClient["consumers"]["get"]>` which
   * would resolve to `Promise<Consumer>` — we use the resolved `Consumer`
   * type directly here.
   */
  async getOrCreateConsumer(userSub: string): Promise<Consumer | null> {
    if (!this.jsm || !this.js) return null;
    const consumerName = buildConsumerName(userSub);
    const filterSubject = buildWorkSubject(userSub);

    try {
      // Try to bind to an existing consumer first
      await this.jsm.consumers.info(STREAM_NAME, consumerName);
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("consumer not found");
      if (!isNotFound) throw err;
      // Create the durable consumer.
      // DeliverPolicy.All ensures work items published before the daemon's
      // first poll are not dropped; in-flight duplicates are deduplicated by
      // the msgID set on publish (runId).
      try {
        await this.jsm.consumers.add(STREAM_NAME, {
          name: consumerName,
          durable_name: consumerName,
          filter_subject: filterSubject,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
        });
      } catch (addErr: unknown) {
        const alreadyExists =
          addErr instanceof Error &&
          (addErr.message.includes("already in use") ||
            addErr.message.includes("already exists"));
        if (!alreadyExists) throw addErr;
        // A concurrent poller created it — fall through to get()
      }
    }

    return this.js.consumers.get(STREAM_NAME, consumerName);
  }
}
