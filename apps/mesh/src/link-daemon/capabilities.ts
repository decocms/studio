import type { Capability } from "@/links/protocol";

/**
 * Detected at daemon startup and re-probed periodically while a CLI is
 * missing (see `startCapabilityReprobe`). The result rides the existing
 * `capabilities: Capability[]` field on the registration payload, so the
 * cluster sees an accurate view of what this desktop can actually run.
 *
 * `decopilot-sandbox` is unconditional — the daemon process IS the sandbox
 * host, so it can always serve that capability.
 */
export interface CapabilityProbes {
  detectClaudeCode: () => Promise<boolean>;
  detectCodex: () => Promise<boolean>;
}

export async function detectCapabilities(
  probes: CapabilityProbes = defaultProbes,
): Promise<Capability[]> {
  // `body-offload` is a daemon-code capability — this daemon build always
  // supports re-inflating offloaded messages (Task 6 added that code), so it
  // is advertised unconditionally regardless of any external probe.
  const caps: Capability[] = ["decopilot-sandbox", "body-offload"];
  const [hasClaudeCode, hasCodex] = await Promise.all([
    probes.detectClaudeCode().catch(() => false),
    probes.detectCodex().catch(() => false),
  ]);
  if (hasClaudeCode) caps.push("claude-code");
  if (hasCodex) caps.push("codex");
  return caps;
}

/** CLI-backed capabilities that can appear after daemon startup (the user
 * installs / signs into the CLI while the daemon is running). */
const CLI_CAPABILITIES: readonly Capability[] = ["claude-code", "codex"];

/** CLI capabilities not present in `current` — the re-probe targets. */
export function missingCliCapabilities(
  current: readonly Capability[],
): Capability[] {
  return CLI_CAPABILITIES.filter((c) => !current.includes(c));
}

/**
 * Grow-only merge of a re-probe result into the live capability array,
 * IN PLACE — the same array reference is shared with the poll loops, which
 * read it on every poll, so mutation is the propagation mechanism.
 *
 * Grow-only on purpose: a transient probe failure (CLI busy, SDK hiccup)
 * must never un-advertise a capability mid-run — dispatch routing would
 * start bouncing threads that are actively streaming. Returns the newly
 * added capabilities (empty when nothing changed).
 */
export function mergeProbedCapabilities(
  current: Capability[],
  probed: readonly Capability[],
): Capability[] {
  const added = probed.filter((c) => !current.includes(c));
  current.push(...added);
  return added;
}

/**
 * Re-probe CLI capabilities every `intervalMs` while at least one is
 * missing, merging discoveries into `capabilities` in place. Probing stops
 * being useful once every CLI capability is present, so those ticks are
 * skipped (each claude-code probe spawns the agent SDK — not free).
 * Returns a cancel function for daemon shutdown.
 */
export function startCapabilityReprobe(
  capabilities: Capability[],
  opts: {
    intervalMs?: number;
    detect?: () => Promise<Capability[]>;
    onChange?: (added: Capability[]) => void;
  } = {},
): () => void {
  const detect = opts.detect ?? (() => detectCapabilities());
  const timer = setInterval(() => {
    if (missingCliCapabilities(capabilities).length === 0) return;
    void detect()
      .then((probed) => {
        const added = mergeProbedCapabilities(capabilities, probed);
        if (added.length > 0) opts.onChange?.(added);
      })
      .catch(() => {
        /* probe failures are expected while the CLI is absent */
      });
  }, opts.intervalMs ?? 60_000);
  // Don't let the re-probe timer hold the process open on shutdown.
  timer.unref?.();
  return () => clearInterval(timer);
}

async function detectClaudeCode(): Promise<boolean> {
  try {
    const [{ query }, { resolveClaudeCodeExecutable }] = await Promise.all([
      import("@anthropic-ai/claude-agent-sdk"),
      import("@decocms/harness/claude-code/resolve-executable"),
    ]);
    // Pin the host-matching native binary so detection doesn't trip over the
    // SDK's libc misdetection (which can pick the unrunnable `-musl` binary on
    // glibc). Omitted when undefined so the SDK resolves as before.
    const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();
    const q = query({
      prompt: "",
      options: {
        maxTurns: 1,
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      },
    });
    const info = await q.accountInfo();
    q.return(undefined);
    return Boolean(info.email);
  } catch {
    return false;
  }
}

async function detectCodex(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["codex", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timeout);
    return code === 0;
  } catch {
    return false;
  }
}

const defaultProbes: CapabilityProbes = {
  detectClaudeCode,
  detectCodex,
};
