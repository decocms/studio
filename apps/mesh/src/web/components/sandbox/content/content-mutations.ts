/**
 * Pure helpers for Content tab CRUD: unique-key generation, duplicate
 * value derivation. All decofile-aware logic lives here so the UI layer
 * stays declarative.
 */

import {
  createEmptyPageBlock,
  generatePageBlockKey,
} from "@/web/components/sections-editor/page-block-template";
import { normalizePagePath } from "@/web/components/sections-editor/page-path-utils";
import type { PageEntry } from "@/web/components/sections-editor/page-list";

/**
 * Append " (copy)", " (copy 2)", … until the result doesn't collide.
 * Used for both page and section display names — purely cosmetic.
 */
export function nextUniqueName(
  taken: ReadonlySet<string>,
  baseName: string,
): string {
  const stripped = baseName.replace(/\s*\(copy(?:\s+\d+)?\)\s*$/, "").trim();
  const candidate = `${stripped} (copy)`;
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = `${stripped} (copy ${i})`;
    if (!taken.has(next)) return next;
  }
  return `${stripped} (copy ${Date.now()})`;
}

/**
 * Append "-copy", "-copy-2", … until the path is free. Pages are routed
 * by `path`, so collisions must be resolved before saving.
 */
export function nextUniquePagePath(
  takenPaths: ReadonlySet<string>,
  basePath: string,
): string {
  const norm = normalizePagePath;
  const stripped = basePath.replace(/-copy(?:-\d+)?$/, "");
  const candidate = `${stripped}-copy`;
  if (!takenPaths.has(norm(candidate))) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = `${stripped}-copy-${i}`;
    if (!takenPaths.has(norm(next))) return next;
  }
  return `${stripped}-copy-${Date.now()}`;
}

/**
 * Append "_copy", "_copy_2", … until the block key is unused. Section
 * keys double as resolveType references, so collisions would shadow an
 * existing block.
 */
export function nextUniqueBlockKey(
  decofile: Record<string, unknown>,
  baseKey: string,
): string {
  const stripped = baseKey.replace(/_copy(?:_\d+)?$/, "");
  const candidate = `${stripped}_copy`;
  if (!Object.hasOwn(decofile, candidate)) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = `${stripped}_copy_${i}`;
    if (!Object.hasOwn(decofile, next)) return next;
  }
  return `${stripped}_copy_${Date.now()}`;
}

/**
 * Build the (key, data) pair for a duplicated page. Reuses
 * `generatePageBlockKey` so the new key carries a fresh uuid suffix
 * (avoids brittle key collisions and matches the `useCreatePage` shape).
 */
export function buildDuplicatePage(args: {
  source: Record<string, unknown>;
  pages: PageEntry[];
  newName: string;
  newPath: string;
}): { key: string; data: Record<string, unknown> } {
  const key = generatePageBlockKey(args.newName);
  const data: Record<string, unknown> = {
    ...args.source,
    name: args.newName,
    path: args.newPath,
  };
  return { key, data };
}

/**
 * Build an empty page block — thin wrapper so callers don't import
 * `page-block-template` directly (lets us swap defaults centrally).
 */
export function buildEmptyPage(name: string, path: string) {
  return createEmptyPageBlock(name, path);
}

const MAX_UNIQUE_KEY_ATTEMPTS = 1000;

/** Fresh `pages-<name>-<uuid>` key that does not collide with an existing decofile entry. */
export function generateUniquePageBlockKey(
  decofile: Record<string, unknown>,
  name: string,
): string {
  for (let i = 0; i < MAX_UNIQUE_KEY_ATTEMPTS; i++) {
    const key = generatePageBlockKey(name);
    if (!Object.hasOwn(decofile, key)) return key;
  }
  throw new Error("Could not generate a unique page block key");
}
