import type { HarnessStreamInput, UIMessageChunk } from "@decocms/harness/types";
import type { SandboxClient } from "./sandbox-client";

/**
 * RemoteSandboxClient — the desktop (out-of-process) `SandboxClient`.
 *
 * The counterpart to mesh's in-process `InProcessSandboxClient`: instead of
 * running the harness in-process, it relays the run over the desktop pull
 * transport and yields the daemon's raw `UIMessageChunk` stream
 * byte-identically (no adapter / reframing — `consumeHarnessStream` consumes it
 * unchanged).
 *
 * The relay generator is INJECTED, never imported: the cluster-side dispatch
 * (`handle-local-dispatch.ts`) closes over `StudioContext`, so importing it here
 * would drag cluster code + a second AI-SDK into the daemon bundle. The
 * transport-layer-sync plan supplies the concrete relay (WS uplink + durable
 * outbox + NATS); this class is the stable boundary it builds on.
 */
export interface RemoteSandboxClientDeps {
  /**
   * Relays one harness run over the desktop transport, yielding the daemon's
   * raw chunk stream. Implemented by the transport layer; this client is a thin
   * pass-through over it.
   */
  relay: (input: HarnessStreamInput) => AsyncIterable<UIMessageChunk>;
  /** Optional sandbox preview URL, as the daemon already exposes. */
  getPreviewUrl?: () => Promise<string | null>;
}

export class RemoteSandboxClient implements SandboxClient {
  constructor(private readonly deps: RemoteSandboxClientDeps) {}

  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
    // Pass-through: yield the relayed chunks unchanged (byte-identical).
    return this.deps.relay(input);
  }

  getPreviewUrl(): Promise<string | null> {
    return this.deps.getPreviewUrl?.() ?? Promise.resolve(null);
  }
}
