/**
 * Thin Jira Cloud client (Basic auth: email + API token).
 *
 * Deliberately not an SDK: the integration needs six endpoints. The sync is
 * board-centric, so issue reads go through the Agile API — a board's visible
 * cards are `/board/{id}/issue` minus `/board/{id}/backlog`, a membership
 * that no JQL over the project can express.
 */

import { retry } from "@decocms/shared/std";
import { wikiToMarkdown } from "./wiki-markdown";

const REQUEST_TIMEOUT_MS = 15_000;

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  /** Project the board lives in, when Jira exposes it. */
  projectKey?: string;
}

export interface JiraBoardColumn {
  name: string;
  /** Status NAMES grouped under this column. */
  statuses: string[];
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    priority: { name: string } | null;
    issuetype: { name: string; hierarchyLevel?: number } | null;
    /** ISO-ish timestamp, e.g. "2026-08-18T11:15:00.000-0300". */
    updated: string;
    /** Atlassian Document Format tree, or null. */
    description: unknown;
    /** Embedded comment page — may be partial; check `total`. */
    comment?: { comments: JiraComment[]; total: number } | null;
  };
}

export interface JiraComment {
  id: string;
  author: { accountId: string; displayName: string } | null;
  /** Atlassian Document Format tree. */
  body: unknown;
  created: string;
}

const ISSUE_FIELDS =
  "summary,status,priority,issuetype,updated,description,comment";

/**
 * Determine if a fetch error should be retried. Transient failures (5xx, timeout,
 * network error) should retry; permanent failures (4xx, auth) should fail fast.
 */
function isRetriableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Retry on timeout (AbortError) or network errors.
  if (
    message.includes("AbortError") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET")
  ) {
    return true;
  }
  // Retry on 5xx server errors; extract from message "Jira {path} failed ({status})".
  const statusMatch = message.match(/failed \((\d+)\)/);
  if (statusMatch && statusMatch[1]) {
    const status = parseInt(statusMatch[1], 10);
    // Retry 5xx and 429 (rate limit); do NOT retry 4xx (auth, not found, etc.).
    return status >= 500 || status === 429;
  }
  // Unknown error — retry with caution.
  return true;
}

/**
 * "acme.atlassian.net" or a pasted URL → "https://acme.atlassian.net".
 *
 * Restricted to Jira Cloud's own domain on purpose: this URL is fetched
 * server-side with the tenant's credentials attached and the response body
 * surfaces in `last_sync_error`, so accepting an arbitrary host would make an
 * `org:manage` principal able to read anything the API pod can reach — a link
 * local address, an internal service, a look-alike domain harvesting the
 * token. Self-hosted Data Center would need an explicit allowlist, not a
 * loosening of this.
 */
const JIRA_CLOUD_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;

export function normalizeSiteUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid Jira site URL: ${input}`);
  }
  if (!JIRA_CLOUD_HOST.test(hostname)) {
    throw new Error(
      `Invalid Jira site URL: ${input} — expected <your-site>.atlassian.net`,
    );
  }
  return `https://${hostname}`;
}

/** Guard for interpolating a board id into a path. */
export function assertBoardId(boardId: string): string {
  if (!/^\d+$/.test(boardId)) {
    throw new Error(`Invalid Jira board id: ${boardId}`);
  }
  return boardId;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(siteUrl: string, email: string, apiToken: string) {
    this.baseUrl = normalizeSiteUrl(siteUrl);
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return retry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.text().catch(() => "");
        if (!response.ok) {
          throw new Error(
            `Jira ${path} failed (${response.status}): ${body.slice(0, 300)}`,
          );
        }
        // Transition POSTs answer 204 with an empty body.
        return (body === "" ? undefined : JSON.parse(body)) as T;
      },
      {
        maxAttempts: 3,
        minTimeout: 100,
        maxTimeout: 5000,
        multiplier: 2,
        jitter: 1,
        isRetriable: isRetriableError,
      },
    );
  }

  /** Cheapest authenticated call — used to validate credentials on save. */
  async myself(): Promise<{ accountId: string; displayName: string }> {
    return this.request("/rest/api/3/myself");
  }

  /** Boards visible to the credentials — the sync-target picker. */
  async listBoards(): Promise<JiraBoard[]> {
    const boards: JiraBoard[] = [];
    let startAt = 0;
    while (boards.length < 200) {
      const page = await this.request<{
        values: Array<{
          id: number;
          name: string;
          type: string;
          location?: { projectKey?: string };
        }>;
        isLast: boolean;
      }>(`/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`);
      boards.push(
        ...page.values.map((board) => ({
          id: board.id,
          name: board.name,
          type: board.type,
          projectKey: board.location?.projectKey,
        })),
      );
      if (page.isLast || page.values.length === 0) break;
      startAt += page.values.length;
    }
    return boards;
  }

  /** The board's columns with their status NAMES, in board order — what the
   *  mapping UI shows (tenants know column names, not raw statuses). */
  async getBoardColumns(boardId: string): Promise<JiraBoardColumn[]> {
    const config = await this.request<{
      columnConfig?: {
        columns?: Array<{ name: string; statuses?: Array<{ id: string }> }>;
      };
    }>(`/rest/agile/1.0/board/${assertBoardId(boardId)}/configuration`);
    const nameById = new Map<string, string>();
    const columns: JiraBoardColumn[] = [];
    for (const column of config.columnConfig?.columns ?? []) {
      const statuses: string[] = [];
      for (const status of column.statuses ?? []) {
        if (!nameById.has(status.id)) {
          const detail = await this.request<{ name: string }>(
            `/rest/api/3/status/${encodeURIComponent(status.id)}`,
          );
          nameById.set(status.id, detail.name);
        }
        statuses.push(nameById.get(status.id) ?? status.id);
      }
      columns.push({ name: column.name, statuses });
    }
    return columns;
  }

  /** One page of the board's issues (backlog included — subtract it via
   *  `listBacklogIssueIds`), optionally narrowed by JQL. */
  async listBoardIssues(params: {
    boardId: string;
    jql: string;
    startAt: number;
  }): Promise<{ issues: JiraIssue[]; total: number }> {
    const query = new URLSearchParams({
      startAt: String(params.startAt),
      maxResults: "100",
      jql: params.jql,
      fields: ISSUE_FIELDS,
    });
    const page = await this.request<{ issues?: JiraIssue[]; total: number }>(
      `/rest/agile/1.0/board/${assertBoardId(params.boardId)}/issue?${query}`,
    );
    return { issues: page.issues ?? [], total: page.total };
  }

  /** Ids of issues sitting in the board's Backlog tab — they have normal
   *  statuses but are NOT visible board cards. */
  async listBacklogIssueIds(boardId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let startAt = 0;
    while (ids.size < 5_000) {
      const page = await this.request<{
        issues?: Array<{ id: string }>;
        total: number;
      }>(
        `/rest/agile/1.0/board/${assertBoardId(boardId)}/backlog?startAt=${startAt}&maxResults=100&fields=id`,
      );
      for (const issue of page.issues ?? []) ids.add(issue.id);
      startAt += page.issues?.length ?? 0;
      if (startAt >= page.total || (page.issues?.length ?? 0) === 0) break;
    }
    return ids;
  }

  /** Transitions available from the issue's CURRENT status — Jira never sets
   *  status directly; you post the transition whose `to` is the target. */
  async listTransitions(
    issueId: string,
  ): Promise<Array<{ id: string; name: string; to: { name: string } }>> {
    const page = await this.request<{
      transitions?: Array<{ id: string; name: string; to: { name: string } }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`);
    return page.transitions ?? [];
  }

  /** The issue's current status name — the idempotency check for a status
   *  push that may have already landed (crash between the POST and our own
   *  bookkeeping), so a retry reads the world instead of re-POSTing. */
  async getStatusName(issueId: string): Promise<string | null> {
    const issue = await this.request<{
      fields?: { status?: { name?: string } };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=status`);
    return issue.fields?.status?.name ?? null;
  }

  async transitionIssue(issueId: string, transitionId: string): Promise<void> {
    await this.request<void>(
      `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`,
      {
        method: "POST",
        body: JSON.stringify({ transition: { id: transitionId } }),
      },
    );
  }

  /** All comments on an issue, oldest first. */
  async listComments(issueId: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    while (comments.length < 1_000) {
      const page = await this.request<{
        comments: JiraComment[];
        total: number;
      }>(
        `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
      );
      comments.push(...page.comments);
      if (comments.length >= page.total || page.comments.length === 0) break;
      startAt += page.comments.length;
    }
    return comments;
  }

  /** Post a comment (as the credential's account). Returns the Jira id. */
  async addComment(issueId: string, text: string): Promise<{ id: string }> {
    return this.request(
      `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
      { method: "POST", body: JSON.stringify({ body: textToAdf(text) }) },
    );
  }
}

/** Plain text → minimal ADF: one paragraph per non-empty line. Rich
 *  formatting (bold, images, links-as-cards) is dropped on purpose. */
export function textToAdf(text: string): unknown {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return {
    type: "doc",
    version: 1,
    content:
      lines.length > 0
        ? lines.map((line) => ({
            type: "paragraph",
            content: [{ type: "text", text: line }],
          }))
        : [{ type: "paragraph", content: [] }],
  };
}

/** Jira rich body → text the cards can render. The Agile API returns
 *  v2-style STRING bodies (wiki markup — converted to markdown); REST v3
 *  returns an ADF tree, which is flattened: text nodes concatenated,
 *  doc-level blocks separated by blank lines. ADF marks, tables, and media
 *  are dropped — the card links back to the issue for full fidelity. */
export function jiraBodyToText(adf: unknown): string {
  if (typeof adf === "string") return wikiToMarkdown(adf);
  if (!adf || typeof adf !== "object") return "";
  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (Array.isArray(node.content) ? node.content : []).map(
    jiraBodyToText,
  );
  if (node.type === "doc") {
    return inner.filter((text) => text.trim() !== "").join("\n\n");
  }
  return inner.join("");
}
