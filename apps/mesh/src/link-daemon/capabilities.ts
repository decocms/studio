import type { Capability } from "@/links/protocol";

/**
 * Detected once at daemon startup. The result rides the existing
 * `capabilities: Capability[]` field on the registration payload, so the
 * cluster sees an accurate view of what this laptop can actually run.
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
  const caps: Capability[] = ["decopilot-sandbox"];
  const [hasClaudeCode, hasCodex] = await Promise.all([
    probes.detectClaudeCode().catch(() => false),
    probes.detectCodex().catch(() => false),
  ]);
  if (hasClaudeCode) caps.push("claude-code");
  if (hasCodex) caps.push("codex");
  return caps;
}

async function detectClaudeCode(): Promise<boolean> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const q = query({ prompt: "", options: { maxTurns: 1 } });
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
