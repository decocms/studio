/**
 * desktop-tool-ctx — narrow context types for the import-isolated desktop path.
 *
 * The desktop daemon factory (`./desktop-factory.ts`) is registered in the
 * daemon (`packages/sandbox/daemon/entry.ts`) and the daemon-safe desktop leaves
 * it pulls (this file, `desktop-runtime`, `desktop-local-tools`, `desktop-prompt`)
 * therefore MUST NOT pull cluster code into the bundle. Two rules keep them
 * portable:
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
 * objectStorage may be backed by Studio's HTTP object-storage API on the
 * desktop so shared storage-aware built-ins can run without S3 credentials.
 */

import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";

export interface DesktopToolCtx {
  objectStorage?: BoundObjectStorage | null;
  organization?: { id: string; slug?: string };
  auth?: { user?: { id: string } };
  baseUrl?: string;
  metadata?: { requestId?: string; userAgent?: string | null };
}
