/** Application settings resolved from environment variables on first access. */
import { resolveConfig } from "./resolve-config";
import type { Settings } from "./types";

let _settings: Settings | null = null;

export function setGlobalSettings(s: Settings): void {
  _settings = Object.freeze(s);
}

export function getSettings(): Settings {
  return (_settings ??= Object.freeze(resolveConfig(process.env)));
}

/**
 * Whether this deployment can run sandbox-hosted harnesses (`claude-code`):
 * the hosted provider is configured. The one definition of that availability —
 * `/api/config` reports it as `runtime.agentSandbox`, and harness selection
 * must consult it BEFORE picking `claude-code`, or a disabled deployment
 * enqueues runs that fail only at dispatch.
 */
export function agentSandboxEnabled(): boolean {
  return getSettings().agentSandboxEnabled;
}

export type { Settings } from "./types";
