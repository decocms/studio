/**
 * Stub for the branch picker's release store.
 *
 * The real `use-releases` reads the list off the Virtual MCP entity via `@/sdk`
 * (`useProjectContext` / `useVirtualMCP`), which needs the full app provider
 * tree. The picker's filtering doesn't care where the list came from, so the CT
 * harness serves a fixture and keeps the mutations as no-ops.
 */

import type { Release } from "@decocms/shared/sdk/types";

const stubReleases: Release[] = [];

export function setStubReleases(next: Release[]) {
  stubReleases.length = 0;
  stubReleases.push(...next);
}

const RELEASE_COLORS = ["orange", "violet", "blue", "pink", "amber", "teal"];

export function nextReleaseColor(count: number): string {
  return RELEASE_COLORS[count % RELEASE_COLORS.length]!;
}

export function nextDraftName(releases: Release[], base: string): string {
  const prefix = `${base} `;
  const max = releases.reduce((m, r) => {
    if (!r.name.startsWith(prefix)) return m;
    const n = Number(r.name.slice(prefix.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return `${base} ${max + 1}`;
}

const DOT_CLASS: Record<string, string> = {
  orange: "bg-orange-500",
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  amber: "bg-amber-500",
  teal: "bg-teal-500",
};

export function releaseDotClass(color: string | undefined): string {
  return (color && DOT_CLASS[color]) || "bg-muted-foreground";
}

export function useReleases(_virtualMcpId: string) {
  return {
    releases: stubReleases,
    createRelease: async (_r: Release) => {},
    renameRelease: async (_branch: string, _name: string) => {},
    deleteRelease: async (_branch: string) => {},
  };
}
