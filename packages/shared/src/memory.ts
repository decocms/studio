/**
 * The two `MEMORY.md` indexes every chat starts with, on the org filesystem's
 * `home` volume: one shared org-wide, one per member.
 */

export type MemoryScope = "organization" | "user";

/** Characters of each index folded into a prompt; the rest is read on demand. */
export const MEMORY_INJECT_CAP = 16_000;

export function memoryPath(scope: MemoryScope, userId: string): string {
  return scope === "organization" ? "MEMORY.md" : `users/${userId}/MEMORY.md`;
}

/** Starter content seeded on first load so the agent's later read never misses. */
export function memoryTemplate(scope: MemoryScope): string {
  return scope === "organization"
    ? "# Organization memory\n\nDurable facts shared with everyone in this organization. Keep this a concise, curated index — not a log.\n"
    : "# User memory\n\nFacts and preferences specific to you. Keep this a concise, curated index — not a log.\n";
}
