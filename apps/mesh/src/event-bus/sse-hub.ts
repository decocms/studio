/**
 * SSE Hub — In-memory fan-out for event bus events
 *
 * Provides a lightweight pub/sub layer that SSE connections subscribe to.
 * When events are published through the EventBus, they are also pushed
 * to all connected SSE clients for the same organization.
 *
 * Cross-pod support:
 * The hub delegates broadcasting to an SSEBroadcastStrategy. In single-process
 * mode (LocalSSEBroadcast), events stay in-memory. In multi-pod deployments
 * (NatsSSEBroadcast), events are replicated to all pods via NATS pub/sub.
 *
 * Design goals:
 * - Zero buffering: events are written directly to the stream
 * - Org-scoped: listeners are keyed by organizationId
 * - Bounded: max connections per org to prevent OOM
 * - Cleanup on disconnect: listeners removed when HTTP connection closes
 * - Pluggable broadcast: strategy handles cross-process replication
 */

import type { Event } from "../storage/types";
import {
  LocalSSEBroadcast,
  type SSEBroadcastStrategy,
} from "./sse-broadcast-strategy";

// ============================================================================
// Types
// ============================================================================

export interface SSEListener {
  /** Unique listener ID for removal */
  id: string;
  /** Organization this listener belongs to */
  organizationId: string;
  /** Optional event type patterns to filter (supports wildcard suffix, e.g. "workflow.*") */
  typePatterns: string[] | null;
  /** Callback to push an event to the SSE stream */
  push: (event: SSEEvent) => void;
}

export interface SSEEvent {
  id: string;
  type: string;
  source: string;
  subject?: string | null;
  data?: unknown;
  time: string;
}

// ============================================================================
// Configuration
// ============================================================================

/** Maximum concurrent SSE connections per organization */
const MAX_CONNECTIONS_PER_ORG = 50;

/** Maximum total SSE connections across all orgs */
const MAX_TOTAL_CONNECTIONS = 500;

// ============================================================================
// SSE Hub
// ============================================================================

/**
 * SSE hub for fan-out of event bus events to SSE connections.
 *
 * Holds references to active listener callbacks — no event data.
 * Memory usage is proportional to connected SSE clients, not event volume.
 *
 * The broadcast strategy controls whether events reach only this process
 * (LocalSSEBroadcast) or all pods (NatsSSEBroadcast).
 */
class SSEHub {
  /** Listeners indexed by organizationId for fast lookup */
  private listeners = new Map<string, Map<string, SSEListener>>();
  private totalCount = 0;
  private strategy: SSEBroadcastStrategy = new LocalSSEBroadcast();
  private started = false;

  /**
   * Initialize the hub with a broadcast strategy and start it.
   * Must be called before emit() for cross-pod broadcasting to work.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async start(strategy?: SSEBroadcastStrategy): Promise<void> {
    if (this.started) return;

    if (strategy) {
      this.strategy = strategy;
    }

    await this.strategy.start((orgId, event) => this.localEmit(orgId, event));
    this.started = true;
  }

  /**
   * Stop the broadcast strategy and release resources.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.strategy.stop();
    this.started = false;
  }

  /**
   * Register a new SSE listener for an organization.
   *
   * @returns The listener ID (for removal), or null if limits are exceeded.
   */
  add(listener: SSEListener): string | null {
    if (this.totalCount >= MAX_TOTAL_CONNECTIONS) {
      console.warn(
        `[SSEHub] Total connection limit reached (${MAX_TOTAL_CONNECTIONS})`,
      );
      return null;
    }

    let orgListeners = this.listeners.get(listener.organizationId);
    if (!orgListeners) {
      orgListeners = new Map();
      this.listeners.set(listener.organizationId, orgListeners);
    }

    if (orgListeners.size >= MAX_CONNECTIONS_PER_ORG) {
      console.warn(
        `[SSEHub] Per-org connection limit reached for ${listener.organizationId} (${MAX_CONNECTIONS_PER_ORG})`,
      );
      return null;
    }

    orgListeners.set(listener.id, listener);
    this.totalCount++;

    return listener.id;
  }

  /**
   * Remove a listener by ID and organization.
   */
  remove(organizationId: string, listenerId: string): void {
    const orgListeners = this.listeners.get(organizationId);
    if (!orgListeners) return;

    if (orgListeners.delete(listenerId)) {
      this.totalCount--;
      if (orgListeners.size === 0) {
        this.listeners.delete(organizationId);
      }
    }
  }

  /**
   * Broadcast an event to all SSE listeners across all pods.
   *
   * Delegates to the configured SSEBroadcastStrategy which handles
   * both local delivery and cross-pod replication.
   */
  emit(organizationId: string, event: SSEEvent): void {
    this.strategy.broadcast(organizationId, event);
  }

  /**
   * Get the number of active listeners for an organization.
   */
  countForOrg(organizationId: string): number {
    return this.listeners.get(organizationId)?.size ?? 0;
  }

  /**
   * Get total active listener count.
   */
  get count(): number {
    return this.totalCount;
  }

  /**
   * Deliver an event to local SSE listeners only (called by the strategy).
   * This is the actual fan-out to HTTP streams on this process.
   */
  private localEmit(organizationId: string, event: SSEEvent): void {
    const orgListeners = this.listeners.get(organizationId);
    if (!orgListeners || orgListeners.size === 0) return;

    for (const listener of orgListeners.values()) {
      if (
        listener.typePatterns &&
        !matchesAnyPattern(event.type, listener.typePatterns)
      ) {
        continue;
      }

      try {
        listener.push(event);
      } catch {
        this.remove(organizationId, listener.id);
      }
    }
  }
}

// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * Check if an event type matches any of the given patterns.
 * Supports exact match and wildcard suffix (e.g., "workflow.*" matches "workflow.execution.created").
 */
function matchesAnyPattern(eventType: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // "workflow." from "workflow.*"
      if (eventType.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ============================================================================
// Singleton & Helpers
// ============================================================================

/** Global SSE hub instance */
export const sseHub = new SSEHub();

/**
 * Convert a database Event to an SSEEvent for streaming.
 */
export function toSSEEvent(event: Event): SSEEvent {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    subject: event.subject,
    data: event.data ? tryParseJSON(event.data) : undefined,
    time: event.time,
  };
}

function tryParseJSON(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
