/**
 * Cross-replica failure counter for durable connection auto-disable.
 *
 * The in-memory circuit breaker (./circuit-breaker) fast-fails per replica to
 * bound latency, but it can't decide to durably disable a connection: behind a
 * load balancer each replica only sees a fraction of the traffic, so no single
 * replica's count reflects the fleet. This store aggregates non-auth failures
 * across ALL replicas in NATS JetStream KV, so any one replica can flip a
 * persistently-failing connection to status="error" — after which every replica
 * fast-fails via the cheap DB status gate, with no downstream handshake.
 *
 * Entries carry a bucket TTL, so a connection that stops failing has its window
 * self-reset; a single success clears the counter immediately.
 */

import { type JetStreamClient, StorageType } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { nanos } from "@nats-io/nats-core";
import { jsonCodec } from "../nats/json-codec";
import {
  CONNECTION_CIRCUIT_TTL_MS,
  CONNECTION_DISABLE_FAILURE_THRESHOLD,
  CONNECTION_DISABLE_MIN_WINDOW_MS,
} from "../core/constants";

interface CircuitRecord {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
}

export interface FailureDecision {
  /** Aggregated non-auth failure count within the current window. */
  count: number;
  /** True once failures crossed the threshold AND were sustained past the window. */
  shouldDisable: boolean;
}

const NO_DISABLE: FailureDecision = { count: 0, shouldDisable: false };

export interface ConnectionCircuitStore {
  /** Record a non-auth failure and report whether the connection should be disabled. */
  recordFailure(connectionId: string): Promise<FailureDecision>;
  /** Clear a connection's failure window after a successful contact. */
  recordSuccess(connectionId: string): Promise<void>;
  teardown(): void;
}

/**
 * Pure decision: does this accumulated record warrant a durable disable?
 * Requires both a threshold count AND a sustained window so a brief burst can't
 * trip it. Exported for unit testing.
 */
export function shouldDisableForRecord(record: CircuitRecord): boolean {
  const sustainedMs = record.lastFailureAt - record.firstFailureAt;
  return (
    record.count >= CONNECTION_DISABLE_FAILURE_THRESHOLD &&
    sustainedMs >= CONNECTION_DISABLE_MIN_WINDOW_MS
  );
}

const KV_BUCKET = "DECOCMS_CONN_CIRCUIT";
const MAX_CAS_ATTEMPTS = 5;

export class JetStreamKVConnectionCircuitStore
  implements ConnectionCircuitStore
{
  private kv: KV | null = null;
  private readonly codec = jsonCodec<CircuitRecord>();

  constructor(
    private readonly options: { getJetStream: () => JetStreamClient | null },
  ) {}

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — disable accounting paused until re-init
    this.kv = await new Kvm(js).create(KV_BUCKET, {
      storage: StorageType.Memory,
      ttl: nanos(CONNECTION_CIRCUIT_TTL_MS),
    });
  }

  async recordFailure(connectionId: string): Promise<FailureDecision> {
    if (!this.kv) return NO_DISABLE;
    const now = Date.now();
    // Optimistic read-increment-write across replicas. create() rejects if a
    // key already exists and update() rejects on a stale revision — either way
    // another replica raced us, so we retry. Best-effort: after a few attempts
    // we give up, since an occasional lost increment only slightly delays the
    // disable, never causes a false one.
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      try {
        const entry = await this.kv.get(connectionId);
        const live =
          entry &&
          entry.operation !== "DEL" &&
          entry.operation !== "PURGE" &&
          entry.value?.length;

        if (!live) {
          const record: CircuitRecord = {
            count: 1,
            firstFailureAt: now,
            lastFailureAt: now,
          };
          await this.kv.create(connectionId, this.codec.encode(record));
          return { count: record.count, shouldDisable: false };
        }

        const prev = this.codec.decode(entry.value);
        const record: CircuitRecord = {
          count: prev.count + 1,
          firstFailureAt: prev.firstFailureAt,
          lastFailureAt: now,
        };
        await this.kv.update(
          connectionId,
          this.codec.encode(record),
          entry.revision,
        );
        return {
          count: record.count,
          shouldDisable: shouldDisableForRecord(record),
        };
      } catch {
        // create race / revision conflict — retry the read-modify-write
      }
    }
    return NO_DISABLE;
  }

  async recordSuccess(connectionId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(connectionId);
    } catch {
      // best-effort, non-critical
    }
  }

  teardown(): void {
    this.kv = null;
  }
}

/**
 * No-op store for test / no-NATS mode. Durable cross-replica disable is paused;
 * the per-replica in-memory circuit breaker still provides fast-fail.
 */
export class NoopConnectionCircuitStore implements ConnectionCircuitStore {
  async recordFailure(): Promise<FailureDecision> {
    return NO_DISABLE;
  }
  async recordSuccess(): Promise<void> {}
  teardown(): void {}
}

// Module-level active store — set once at app startup, read by the proxy route.
let activeStore: ConnectionCircuitStore = new NoopConnectionCircuitStore();

export function setConnectionCircuitStore(
  store: ConnectionCircuitStore | null,
): void {
  activeStore = store ?? new NoopConnectionCircuitStore();
}

export function getConnectionCircuitStore(): ConnectionCircuitStore {
  return activeStore;
}
