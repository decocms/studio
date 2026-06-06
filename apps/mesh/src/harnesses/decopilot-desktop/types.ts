/**
 * decopilot-desktop — narrow context types for the import-isolated harness.
 *
 * This whole subtree (`harnesses/decopilot-desktop/`) is registered in the
 * daemon (`packages/sandbox/daemon/entry.ts`) and therefore MUST NOT pull
 * cluster code into the bundle. Two rules keep it portable:
 *
 *  1. NEVER import `StudioContext` (`@/core/studio-context`). That type derives
 *     from Better-Auth's recursive plugin API; threading it into this tree
 *     makes `tsc` instantiate the deep type and overflow the stack. Use
 *     `DesktopToolCtx` everywhere a reused leaf would otherwise want a
 *     `StudioContext`.
 *  2. Import portable leaves by RELATIVE path (never `@/*`) so the bundle
 *     resolves without the apps/mesh tsconfig alias.
 *
 * `DesktopToolCtx` is the narrow, structurally-typed context the lean tools
 * read. It mirrors the small subset of `StudioContext` the LOCAL-OK built-ins
 * actually touch (`objectStorage`, `organization`, `auth`, `metadata`), and
 * deliberately leaves `objectStorage` as `null` on the desktop so the
 * blob-offload branches in scrape/inspect short-circuit.
 */

export interface DesktopToolCtx {
  /** Object storage is cluster-only — always `null`/absent on the desktop, so
   *  every `if (ctx?.objectStorage)` branch short-circuits to inline output. */
  objectStorage?: null;
  organization?: { id: string; slug?: string };
  auth?: { user?: { id: string } };
  baseUrl?: string;
  metadata?: { requestId?: string; userAgent?: string | null };
}
