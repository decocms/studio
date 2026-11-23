/** What the goal finder may read, and the check that a proposed quote was really said. */

import { memoryTemplate } from "@decocms/shared/memory";
import { PLAN_GOAL_MAX_LENGTH, planGoalKey } from "@decocms/shared/plan-goals";
import type { OrgFsEntry } from "../../storage/org-fs";

/** Goals one search proposes at most; more must not mean more reading. */
export const MAX_GOAL_CANDIDATES = 6;

export interface Evidence {
  kind: "memory" | "file" | "connection";
  /** What the person sees as the source: a file path or a connection name. */
  label: string;
  text: string;
}

type FileEntry = Pick<OrgFsEntry, "path" | "kind" | "threadId" | "deletedAt">;

/** The home files read, newest first; the rest wait for a later look. */
const MAX_FILES = 20;
const MAX_UNREAD = 10;

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "json"]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "key",
  "pages",
]);

/**
 * Business cases repeat the current goal, skills are instructions for agents,
 * and personal homes are private to their owner.
 */
const SKIPPED_FOLDERS = ["plans/", "skills/", "users/"];

/** The org memory is read on its own, ahead of the other files. */
const MEMORY_PATH = "MEMORY.md";

/** Below this, a quote is too short to show that anyone said it. */
const MIN_QUOTE_CHARS = 20;

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A live file a person wrote, outside the folders that never state the goal. */
function isPersonFile(entry: FileEntry): boolean {
  return (
    entry.kind === "file" &&
    entry.deletedAt === null &&
    entry.threadId === null &&
    entry.path !== MEMORY_PATH &&
    !SKIPPED_FOLDERS.some((folder) => entry.path.startsWith(folder))
  );
}

export function isPersonWrittenText(entry: FileEntry): boolean {
  return isPersonFile(entry) && TEXT_EXTENSIONS.has(extension(entry.path));
}

/** A document a person uploaded that the API has no reader for. */
export function isUnreadableDocument(entry: FileEntry): boolean {
  return isPersonFile(entry) && DOCUMENT_EXTENSIONS.has(extension(entry.path));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The evidence that contains the quote, or null when nobody said it. */
export function findQuote(
  quote: string,
  evidence: readonly Evidence[],
): Evidence | null {
  const needle = normalize(quote).replace(/^["'\s]+|["'.,;:!?\s]+$/g, "");
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return evidence.find((item) => normalize(item.text).includes(needle)) ?? null;
}

/** The text files to read, newest first. */
export function filesToRead<T extends FileEntry & { updatedAt: string }>(
  entries: readonly T[],
): T[] {
  return entries
    .filter(isPersonWrittenText)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_FILES);
}

/** The documents to name as not read, so the person knows what was missed. */
export function unreadDocuments(entries: readonly FileEntry[]): string[] {
  return entries
    .filter(isUnreadableDocument)
    .map((entry) => entry.path)
    .slice(0, MAX_UNREAD);
}

/** Whether the org memory says anything beyond the template it is seeded with. */
export function isWrittenMemory(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && trimmed !== memoryTemplate("organization").trim();
}

/**
 * The evidence within budget, in order: each item capped at `perItem`
 * characters, and nothing kept once `total` is spent. Empty items are dropped.
 */
export function withinBudget(
  items: readonly Evidence[],
  perItem: number,
  total: number,
): Evidence[] {
  const kept: Evidence[] = [];
  let spent = 0;
  for (const item of items) {
    const text = item.text
      .trim()
      .slice(0, perItem)
      .slice(0, total - spent);
    if (!text) continue;
    kept.push({ ...item, text });
    spent += text.length;
  }
  return kept;
}

/** The sources read, once each, in the order they were read. */
export function evidenceLabels(evidence: readonly Evidence[]): string[] {
  return [...new Set(evidence.map((item) => item.label))];
}

export type Proposal =
  | { ok: true; statement: string; quote: string; source: Evidence }
  | { ok: false; reason: "not_found" | "not_clear" };

export type Candidate = Extract<Proposal, { ok: true }>;

/**
 * The model's proposal, kept only with both a sentence and a quote, and only
 * when the quote is found in what was read; Jev judges it next.
 */
export function checkProposal(
  proposal: { statement: string | null; quote: string | null },
  evidence: readonly Evidence[],
): Proposal {
  const statement = proposal.statement?.trim();
  const quote = proposal.quote?.trim();
  if (!statement || !quote) return { ok: false, reason: "not_found" };
  const source = findQuote(quote, evidence);
  return source
    ? { ok: true, statement, quote, source }
    : { ok: false, reason: "not_clear" };
}

/** Why a search ended with no candidate to show. */
export type NoCandidateReason = "not_found" | "not_clear" | "already_listed";

/**
 * The model's proposals worth showing, in its order: each one passes
 * `checkProposal`, fits one goal sentence, and is new, neither one of the
 * `existing` goals nor a repeat of an earlier proposal. At most
 * `MAX_GOAL_CANDIDATES`; with none left, `reason` says why.
 */
export function checkCandidates(
  proposals: readonly { statement: string | null; quote: string | null }[],
  evidence: readonly Evidence[],
  existing: readonly string[],
  limit: number = MAX_GOAL_CANDIDATES,
): { candidates: Candidate[]; reason: NoCandidateReason | null } {
  const listedKeys = new Set(existing.map(planGoalKey));
  const proposed = new Set<string>();
  const candidates: Candidate[] = [];
  let unproven = false;
  let listed = false;
  for (const raw of proposals) {
    if (candidates.length >= limit) break;
    const proposal = checkProposal(raw, evidence);
    if (!proposal.ok) {
      unproven ||= proposal.reason === "not_clear";
      continue;
    }
    if (proposal.statement.length > PLAN_GOAL_MAX_LENGTH) continue;
    const key = planGoalKey(proposal.statement);
    if (listedKeys.has(key)) {
      listed = true;
      continue;
    }
    if (!key || proposed.has(key)) continue;
    proposed.add(key);
    candidates.push(proposal);
  }
  if (candidates.length > 0) return { candidates, reason: null };
  return {
    candidates,
    reason: listed ? "already_listed" : unproven ? "not_clear" : "not_found",
  };
}
