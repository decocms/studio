import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolves the Claude Code native binary that matches the current host so we
 * can hand it to the SDK as `pathToClaudeCodeExecutable`.
 *
 * WHY THIS EXISTS — the Claude Agent SDK ships per-platform native binaries
 * (`@anthropic-ai/claude-agent-sdk-linux-x64`, `-linux-x64-musl`, ...) and
 * picks one at spawn time. Its libc check trusts a SINGLE signal:
 * `process.report.getReport().header.glibcVersionRuntime`. On a glibc host that
 * field is normally a version string ("2.35"), but some runtimes (musl-linked
 * or older Bun/Node builds) leave it `undefined` even on glibc — and the SDK
 * then treats the host as musl and selects the `-musl` binary. That binary
 * cannot launch on glibc (its dynamic loader `/lib/ld-musl-*.so.1` is absent),
 * so the chat turn dies with "Claude Code native binary not found at
 * .../claude-agent-sdk-linux-x64-musl/claude" (or a spawn crash).
 *
 * We resolve the binary ourselves using a more robust libc check (a filesystem
 * ground-truth probe in addition to `glibcVersionRuntime`) and pass it
 * explicitly, which bypasses the SDK's built-in detection entirely.
 */

/**
 * Decide whether the host uses the musl C library from the available libc
 * signals. Pure — no `process`/filesystem access — so it is unit testable.
 *
 * `glibcVersionRuntime` is the SDK's only signal; `hasMuslLoader` is the
 * filesystem tie-breaker that keeps glibc hosts from being misclassified when
 * the runtime fails to report a glibc version.
 */
export function decideMusl(signals: {
  platform: NodeJS.Platform;
  glibcVersionRuntime: unknown;
  hasMuslLoader: boolean;
}): boolean {
  if (signals.platform !== "linux") return false;
  // A positive glibc version is authoritative — it means glibc, full stop
  // (and never musl, even if a musl loader happens to be installed too).
  if (
    typeof signals.glibcVersionRuntime === "string" &&
    signals.glibcVersionRuntime.length > 0
  ) {
    return false;
  }
  // No glibc version reported: either a real musl host OR a runtime that just
  // doesn't expose it. The presence of the musl dynamic loader on disk settles
  // it — musl hosts ship it, glibc hosts do not.
  return signals.hasMuslLoader;
}

/**
 * Ordered `claude-agent-sdk-<variant>` suffixes to try, most-preferred first.
 * Pure. Mirrors the SDK's own ordering (preferred libc first, other as
 * fallback) so a host missing its preferred binary still resolves the other.
 */
export function nativeVariantOrder(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string[] {
  if (platform !== "linux") return [`${platform}-${arch}`];
  const gnu = `linux-${arch}`;
  const muslVariant = `linux-${arch}-musl`;
  return musl ? [muslVariant, gnu] : [gnu, muslVariant];
}

/** Maps Node's `process.arch` to the musl loader's machine token. */
function muslLoaderMachine(arch: string): string {
  if (arch === "arm64") return "aarch64";
  if (arch === "x64") return "x86_64";
  return arch;
}

/** musl ships its dynamic loader at /lib/ld-musl-<machine>.so.1; glibc doesn't. */
function hasMuslLoader(arch: string): boolean {
  const machine = muslLoaderMachine(arch);
  return [
    `/lib/ld-musl-${machine}.so.1`,
    `/usr/lib/ld-musl-${machine}.so.1`,
  ].some((p) => existsSync(p));
}

function glibcVersionRuntime(): unknown {
  const report =
    typeof process.report?.getReport === "function"
      ? (process.report.getReport() as {
          header?: { glibcVersionRuntime?: unknown };
        })
      : null;
  return report?.header?.glibcVersionRuntime;
}

/** True when the current host uses the musl C library (e.g. Alpine). */
export function isMuslLibc(): boolean {
  return decideMusl({
    platform: process.platform,
    glibcVersionRuntime: glibcVersionRuntime(),
    hasMuslLoader: hasMuslLoader(process.arch),
  });
}

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Absolute path to the Claude Code native binary matching THIS host, or
 * `undefined` when it can't be resolved (callers should then let the SDK
 * resolve on its own — i.e. preserve today's behavior).
 *
 * Only linux is handled: it is the only platform that ships split gnu/musl
 * native packages, so it is the only one the SDK can get wrong. On
 * macOS/Windows there is a single native package and the SDK resolves it
 * correctly, so we defer to it.
 */
export function resolveClaudeCodeExecutable(): string | undefined {
  if (process.platform !== "linux") return undefined;

  let scopeDir: string;
  try {
    // The native variant packages are installed as siblings of the main SDK
    // package (Bun symlinks them next to it; npm/bunx lay them out flat), so
    // resolve the SDK entry and walk up to the `@anthropic-ai` scope dir.
    const sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    scopeDir = dirname(dirname(sdkEntry));
  } catch {
    return undefined;
  }

  for (const variant of nativeVariantOrder(
    process.platform,
    process.arch,
    isMuslLibc(),
  )) {
    const bin = join(scopeDir, `claude-agent-sdk-${variant}`, "claude");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}
