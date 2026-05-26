import { generateText } from "ai";
import type { MeshContext } from "../core/mesh-context";
import { resolveTier } from "../core/resolve-tier";

export interface CommitSuggestion {
  title: string;
  body: string;
  message: string;
}

export interface GitStatusLike {
  modified: string[];
  created: string[];
  deleted: string[];
  not_added: string[];
}

export interface GitDiffLike {
  diffs: Record<string, { from: string | null; to: string | null }>;
}

const COMMIT_SUGGESTION_SYSTEM = `You write git commit messages and pull request descriptions for web project changes.
Return ONLY valid JSON with this shape:
{"title":"Short imperative commit title (max 72 chars)","body":"1-3 sentence PR description explaining what changed and why"}

Use sentence case for the title. No markdown fences.`;

function isGeneratedNoise(path: string): boolean {
  return /^static\/.*\.css$/.test(path);
}

function changedPaths(status: GitStatusLike): string[] {
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
  ].filter((p) => !isGeneratedNoise(p));
}

function changedLines(
  from: string | null,
  to: string | null,
  { context = 2, maxLines = 40 } = {},
): string {
  if (!from && !to) return "";
  if (!from) {
    return (to ?? "")
      .split("\n")
      .slice(0, maxLines)
      .map((l) => `+ ${l}`)
      .join("\n");
  }
  if (!to) {
    return from
      .split("\n")
      .slice(0, maxLines)
      .map((l) => `- ${l}`)
      .join("\n");
  }

  const a = from.split("\n").slice(0, 300);
  const b = to.split("\n").slice(0, 300);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const prevRow = dp[i - 1];
      const cellLeft = prevRow?.[j] ?? 0;
      const cellUp = prevRow?.[j - 1] ?? 0;
      const prevDiag = prevRow?.[j - 1] ?? 0;
      const row = dp[i];
      if (!row) continue;
      const aLine = a[i - 1];
      const bLine = b[j - 1];
      row[j] =
        aLine !== undefined && bLine !== undefined && aLine === bLine
          ? prevDiag + 1
          : Math.max(cellLeft, cellUp);
    }
  }

  type Op = { op: "=" | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const aLine = i > 0 ? a[i - 1] : undefined;
    const bLine = j > 0 ? b[j - 1] : undefined;
    const row = dp[i];
    const prevRow = dp[i - 1];
    if (
      i > 0 &&
      j > 0 &&
      aLine !== undefined &&
      bLine !== undefined &&
      aLine === bLine
    ) {
      ops.unshift({ op: "=", line: aLine });
      i--;
      j--;
    } else if (
      j > 0 &&
      (i === 0 || (row?.[j - 1] ?? 0) >= (prevRow?.[j] ?? 0))
    ) {
      if (bLine !== undefined) ops.unshift({ op: "+", line: bLine });
      j--;
    } else if (aLine !== undefined) {
      ops.unshift({ op: "-", line: aLine });
      i--;
    } else {
      break;
    }
  }

  const show = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.op !== "=") {
      for (
        let c = Math.max(0, idx - context);
        c <= Math.min(ops.length - 1, idx + context);
        c++
      ) {
        show.add(c);
      }
    }
  });

  if (show.size === 0) return "";

  const result: string[] = [];
  let last = -1;
  for (const idx of [...show].sort((a, b) => a - b)) {
    if (last !== -1 && idx > last + 1) result.push("@@ ... @@");
    const opEntry = ops[idx];
    if (!opEntry) continue;
    const { op, line } = opEntry;
    result.push(`${op === "=" ? " " : op} ${line}`);
    last = idx;
    if (result.length >= maxLines) break;
  }

  return result.join("\n");
}

export function buildCommitContextSummary(
  status: GitStatusLike,
  diff: GitDiffLike,
): string {
  const paths = changedPaths(status);
  const fileLines = [
    ...status.modified.map((f) => `Modified: ${f}`),
    ...status.created.map((f) => `Added: ${f}`),
    ...status.deleted.map((f) => `Deleted: ${f}`),
    ...status.not_added.map((f) => `Added: ${f}`),
  ].join("\n");

  const snippets = paths
    .map((path) => {
      const entry = diff.diffs[path];
      if (!entry) return path;
      const snippet = changedLines(entry.from, entry.to);
      return snippet ? `${path}:\n${snippet}` : path;
    })
    .join("\n---\n");

  return `Changed files:\n${fileLines}\n\nDiff snippets:\n${snippets}`;
}

export function fallbackCommitSuggestion(
  status: GitStatusLike,
): CommitSuggestion {
  const all = [
    ...status.created.map((f) => `add ${f}`),
    ...status.modified.map((f) => `update ${f}`),
    ...status.deleted.map((f) => `delete ${f}`),
    ...status.not_added.map((f) => `add ${f}`),
  ].filter((f) => !isGeneratedNoise(f.replace(/^(add|update|delete) /, "")));

  const label = all.length > 0 ? all[0] : "Update files";
  const extra = all.length > 1 ? ` and ${all.length - 1} more` : "";
  const message = `${label}${extra}`;
  const title = message.charAt(0).toUpperCase() + message.slice(1);

  const bodyPaths = changedPaths(status).slice(0, 5).join(", ");
  return {
    message,
    title,
    body: bodyPaths ? `Changes to ${bodyPaths}.` : "",
  };
}

function parseCommitSuggestionJson(text: string): CommitSuggestion | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { title?: string; body?: string };
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!title) return null;
    return {
      title: title.slice(0, 120),
      body: body.slice(0, 4000),
      message: body ? `${title}\n\n${body}` : title,
    };
  } catch {
    const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
    if (!firstLine) return null;
    return {
      title: firstLine.slice(0, 120),
      body: cleaned.slice(firstLine.length).trim(),
      message: cleaned,
    };
  }
}

export async function suggestCommitMessageWithLlm(
  ctx: MeshContext,
  status: GitStatusLike,
  diff: GitDiffLike,
): Promise<CommitSuggestion> {
  const paths = changedPaths(status);
  if (paths.length === 0) {
    return { title: "No changes", body: "", message: "No changes" };
  }

  const orgId = ctx.organization?.id;
  if (!orgId) return fallbackCommitSuggestion(status);

  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const summary = buildCommitContextSummary(status, diff);

    const result = await generateText({
      model,
      system: COMMIT_SUGGESTION_SYSTEM,
      prompt: summary,
      maxOutputTokens: 400,
      temperature: 0.2,
    });

    const parsed = parseCommitSuggestionJson(result.text);
    if (parsed) return parsed;
  } catch (err) {
    console.warn("[suggest-commit-message] LLM failed, using fallback", err);
  }

  return fallbackCommitSuggestion(status);
}
