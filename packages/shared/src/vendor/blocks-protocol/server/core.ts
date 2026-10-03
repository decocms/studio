/**
 * The shared state of one content handler: its storage, options and caches.
 */
import {
  ContentProtocolError,
  invalidBlock,
  notFound,
  unavailable,
  unsupported,
} from "../errors";
import { blockNameFromFile } from "../keys";
import {
  type ContentStorage,
  type StorageDescription,
  StorageInvalidFileError,
  StorageNotFoundError,
  StorageUnavailableError,
} from "../storage";
import { DEFAULT_LIMITS, type DecoMeta, type Limits } from "../types";
import type { AuthOptions } from "./auth";
import { BodyCache } from "./body-cache";

export interface ContentHandlerOptions extends AuthOptions {
  /** Reported by `describe`, such as `{ name: "deco-cli", version: "8.0.0" }`. */
  server?: { name: string; version: string };
  /** Lowers the protocol's default limits. Higher values are ignored. */
  limits?: Partial<Limits>;
  /** Overrides the poll interval the storage suggests. */
  pollIntervalMs?: number;
  /** Where "open the real page" points. */
  preview?: { origin: string } | null;
  /** How many times `blocks.apply` attempts a commit when storage moved meanwhile (default 3). */
  maxCommitAttempts?: number;
  /**
   * The jittered wait before retrying a commit that found storage moved: a
   * random delay in `[minMs, maxMs]`, times the attempt number (default
   * 50–200 ms), so concurrent writers don't retry in lockstep.
   */
  commitRetryDelayMs?: { minMs: number; maxMs: number };
  /** Bytes of parsed entries kept between requests (default 32 MiB). */
  bodyCacheBytes?: number;
  /** Called with errors that become an Internal error (-32603), for logging. */
  onError?: (error: unknown) => void;
}

const DEFAULT_POLL_MS = { "working-tree": 2000, git: 30000 } as const;
const DEFAULT_RETRY_DELAY = { minMs: 50, maxMs: 200 };

export class Core {
  readonly cache: BodyCache;
  /** Requests in flight per scoped request key, so simultaneous duplicates commit once. */
  readonly inflight = new Map<string, Promise<unknown>>();
  /** The last parsed schema, by version: the secret guard reads it on every write. */
  parsedSchema: { version: string; meta: DecoMeta } | null = null;

  constructor(
    readonly storage: ContentStorage,
    readonly options: ContentHandlerOptions,
  ) {
    this.cache = new BodyCache(options.bodyCacheBytes ?? 32 * 1024 * 1024);
  }

  get maxCommitAttempts(): number {
    return Math.max(1, this.options.maxCommitAttempts ?? 3);
  }

  /** Waits before commit attempt `attempt + 1`: jittered, growing with the attempt. */
  async backoff(attempt: number): Promise<void> {
    const { minMs, maxMs } =
      this.options.commitRetryDelayMs ?? DEFAULT_RETRY_DELAY;
    const ms = (minMs + Math.random() * Math.max(0, maxMs - minMs)) * attempt;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async description(): Promise<StorageDescription> {
    return this.storage.describe();
  }

  /** The effective limits: the lowest of the defaults, the storage's and the options'. */
  limits(description: StorageDescription): Limits {
    const out = { ...DEFAULT_LIMITS };
    for (const source of [description.limits, this.options.limits]) {
      if (!source) continue;
      for (const key of Object.keys(out) as (keyof Limits)[]) {
        const value = source[key];
        if (typeof value === "number" && value > 0 && value < out[key])
          out[key] = value;
      }
    }
    return out;
  }

  pollIntervalMs(description: StorageDescription): number {
    return (
      this.options.pollIntervalMs ??
      description.pollIntervalMs ??
      DEFAULT_POLL_MS[description.kind]
    );
  }

  /** Refuses a `ref` on a storage without branches. */
  checkRef(description: StorageDescription, ref: string | undefined): void {
    if (ref !== undefined && description.refs === null) {
      throw unsupported("this endpoint has no branches; omit ref");
    }
  }
}

/** Maps storage errors to protocol errors; anything unknown is rethrown. */
export function toProtocolError(error: unknown): ContentProtocolError | null {
  if (error instanceof ContentProtocolError) return error;
  if (error instanceof StorageNotFoundError) return notFound(error.message);
  if (error instanceof StorageInvalidFileError) {
    const name = blockNameFromFile(error.file);
    return invalidBlock([
      {
        name,
        rule: "unsupported-name",
        message: `this storage can't hold the entry "${name}"`,
      },
    ]);
  }
  if (error instanceof StorageUnavailableError)
    return unavailable(error.message, error.retryAfterMs);
  return null;
}
