import { matchesTaskKey } from "@/layouts/task-board/task-filters";

/**
 * The card a short link names: by human key (`DECO-01`, a synced card's
 * tracker key like `OS-333`, `deco-1`, `1`) or by raw id.
 *
 * The exact tracker key is checked first, ahead of `matchesTaskKey`'s looser
 * keySeq fallback, so an exact `OS-333` always wins over an unrelated card
 * that merely shares its number.
 *
 * The id fallback exists because a card written before the key backfill has
 * no key and the share button falls back to its id — and because a link,
 * once pasted somewhere, has to keep working.
 */
export function findTaskByKeyOrId<
  T extends {
    id: string;
    keySeq: number | null;
    jiraIssueKey?: string | null;
  },
>(items: T[], term: string | undefined): T | undefined {
  const raw = term?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return (
    items.find((item) => item.jiraIssueKey?.trim().toLowerCase() === lower) ??
    items.find((item) => matchesTaskKey(raw, item.keySeq, item.jiraIssueKey)) ??
    items.find((item) => item.id === raw)
  );
}
