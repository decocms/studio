import type { StudioContextFactory } from "@/automations/fire";

/**
 * Module-level runtime for channel agent turns, mirroring the automations and
 * thread-gate runtimes. App boot wires `meshContextFactory` (the same
 * background context factory automations use) via `setChannelRuntime` so the
 * inbound webhook handler can build a bot-scoped StudioContext without an HTTP
 * session.
 */
export interface ChannelRuntime {
  meshContextFactory: StudioContextFactory;
}

let runtime: ChannelRuntime | null = null;

export function setChannelRuntime(rt: ChannelRuntime): void {
  runtime = rt;
}

export function requireChannelRuntime(): ChannelRuntime {
  if (!runtime) {
    throw new Error(
      "[channels] runtime not initialized — setChannelRuntime() must run at app boot",
    );
  }
  return runtime;
}
