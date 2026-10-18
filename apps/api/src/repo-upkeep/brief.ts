/**
 * A repository brief: what the repository is for, which areas are alive and
 * which are abandoned, and the conventions it follows. Repository upkeep judges
 * every open pull request and issue against it (`docs/plans/repo-upkeep.md`).
 *
 * Built from at most five provider reads — recent commits, the tree, the README,
 * the agent guide, recent merged change requests — plus one fast-tier call.
 * When the default branch has not moved since the last good brief, only the
 * commit read happens and the brief is kept.
 */

import { z } from "zod";
import type { RepoInsightsClient } from "@/git-providers";

const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 200;
const README_BYTES = 12_000;
const GUIDE_BYTES = 8_000;
const ORG_MEMORY_CHARS = 4_000;
const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 30;
const TREE_ENTRIES = 400;

const items = z.array(z.string()).transform((list) =>
  list
    .map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ITEMS),
);

export const RepositoryBriefSchema = z.object({
  purpose: z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.slice(0, 600)),
  activeAreas: items,
  abandonedAreas: items,
  conventions: items,
});

export type RepositoryBrief = z.infer<typeof RepositoryBriefSchema>;

export type BriefOutcome =
  | { kind: "unchanged"; headSha: string | null }
  | { kind: "built"; headSha: string | null; brief: RepositoryBrief }
  | { kind: "skipped"; reason: string };

export interface BriefDeps {
  /** One JSON answer from the org's fast tier; see `core/fast-tier-json.ts`. */
  ask: (
    system: string,
    prompt: string,
  ) => Promise<{ answer: RepositoryBrief } | { skipped: string }>;
  /** The org's shared memory, if any — context the code cannot show. */
  readOrgMemory: () => Promise<string | null>;
}

const BRIEF_SYSTEM = `You write a short brief of a software repository for a maintainer who will triage its open pull requests and issues.
Answer with one JSON object and nothing else:
{"purpose": string, "activeAreas": string[], "abandonedAreas": string[], "conventions": string[]}
- purpose: one or two sentences on what the repository is for and who uses it.
- activeAreas: directories or features with recent work, each with a few words on what is happening.
- abandonedAreas: directories or features that look dead or superseded; empty when unsure.
- conventions: rules a contribution must follow (commit style, tests, layout), taken from the guides.
At most ${MAX_ITEMS} entries per list. State only what the material supports.`;

/** Top-level directories with their file counts, largest first. Pure. */
export function summarizeTree(
  entries: Array<{ path: string; type: "blob" | "tree" }>,
): string {
  const counts = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const slash = entry.path.indexOf("/");
    if (slash === -1) rootFiles.push(entry.path);
    else {
      const dir = entry.path.slice(0, slash);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const dirs = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => `${dir}/ (${n} files)`);
  return [...dirs, ...rootFiles].join("\n");
}

/** The root file matching `pattern`, if the tree has one. Pure. */
export function rootFile(
  entries: Array<{ path: string; type: "blob" | "tree" }>,
  pattern: RegExp,
): string | null {
  return (
    entries.find(
      (e) => e.type === "blob" && !e.path.includes("/") && pattern.test(e.path),
    )?.path ?? null
  );
}

export async function buildBrief(
  client: RepoInsightsClient,
  previous: { headSha: string | null; built: boolean } | null,
  now: Date,
  deps: BriefDeps,
): Promise<BriefOutcome> {
  const since = new Date(
    now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const commits = await client.listCommits({ since, limit: HISTORY_LIMIT });
  const headSha = commits.items[0]?.sha ?? null;
  if (previous?.built && previous.headSha === headSha) {
    return { kind: "unchanged", headSha };
  }

  const tree = await client.listTree({ maxEntries: TREE_ENTRIES });
  const readmePath = rootFile(tree.entries, /^readme(\.\w+)?$/i);
  const guidePath =
    rootFile(tree.entries, /^agents\.md$/i) ??
    rootFile(tree.entries, /^claude\.md$/i);
  const [readme, guide, merged, orgMemory] = await Promise.all([
    readmePath
      ? client.readFile({ path: readmePath, maxBytes: README_BYTES })
      : null,
    guidePath
      ? client.readFile({ path: guidePath, maxBytes: GUIDE_BYTES })
      : null,
    client.listChangeRequests({
      state: "merged",
      updatedAfter: since,
      limit: HISTORY_LIMIT,
    }),
    deps.readOrgMemory().catch(() => null),
  ]);

  const sections = [
    `Repository: ${client.repo.path}`,
    `Top-level layout${tree.truncated ? " (partial)" : ""}:\n${summarizeTree(tree.entries)}`,
    readme?.content ? `README:\n${readme.content}` : "README: (none)",
    guide?.content ? `Contributor guide:\n${guide.content}` : null,
    `Merged in the last ${HISTORY_DAYS} days:\n${
      merged.items
        .map((cr) => `- #${cr.number} ${cr.title} (${cr.mergedAt ?? "?"})`)
        .join("\n") || "(none)"
    }`,
    `Recent commits:\n${
      commits.items
        .map((c) => `- ${c.date.slice(0, 10)} ${c.message.split("\n")[0]}`)
        .join("\n") || "(none)"
    }`,
    orgMemory
      ? `Organization notes:\n${orgMemory.slice(0, ORG_MEMORY_CHARS)}`
      : null,
  ];
  const asked = await deps.ask(
    BRIEF_SYSTEM,
    sections.filter(Boolean).join("\n\n"),
  );
  if ("skipped" in asked) return { kind: "skipped", reason: asked.skipped };
  return { kind: "built", headSha, brief: asked.answer };
}
