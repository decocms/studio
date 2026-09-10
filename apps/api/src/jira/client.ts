/**
 * Thin Jira Cloud client (Basic auth: email + API token).
 *
 * Deliberately not an SDK: the integration needs a handful of endpoints.
 *
 * Issue reads go through JQL search over the board's SAVED FILTER
 * ({@link JiraClient.getBoardScopeJql}), not through the Agile API's
 * `/board/{id}/issue`. That endpoint answers "what is on the board", which
 * silently excludes whatever sits in the board's Backlog tab — the normal
 * place work arrives. The filter is the board's own definition of its scope,
 * backlog included.
 */

import { retry } from "@decocms/shared/std";
import { getSettings } from "@/settings";
import { type AdfMedia, markdownToAdf } from "./markdown-adf";
import {
  collectWikiMentionAccountIds,
  escapeMentionName,
  UNKNOWN_MENTION,
  wikiToMarkdown,
} from "./wiki-markdown";

const REQUEST_TIMEOUT_MS = 15_000;

/** Attachment bytes can be large; the download gets its own budget. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Account ids per `/user/bulk` request. Jira allows 200, but each id spends
 *  ~56 URL bytes, so 200 would build a ~11KB request line — past the 4KB cap
 *  common in proxies, and a 414 is a 4xx: not retried, latching every mention
 *  to `@unknown`. 50 keeps the URL under ~3KB and costs ~1 extra request per
 *  50 distinct people in a page. */
const USER_LOOKUP_CHUNK = 50;

export interface JiraBoard {
  id: number;
  /**
   * The board's own name. For team-managed projects Jira auto-generates this as
   * "<KEY> board" and never shows it in its own UI, so on its own it is not
   * what a human recognizes — pair it with `projectName`.
   */
  name: string;
  type: string;
  /** Project the board lives in, when Jira exposes it. */
  projectKey?: string;
  /** The project's name — what Jira's own board header shows. */
  projectName?: string;
}

export interface JiraBoardColumn {
  name: string;
  /** Status NAMES grouped under this column. */
  statuses: string[];
}

export interface JiraIssueFields {
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
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType?: string;
}

/** One changelog entry: what changed on the issue, and when. */
export interface JiraChangelogHistory {
  id: string;
  created: string;
  items: Array<{ field: string; toString?: string | null; to?: string | null }>;
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

/** Issues per search page. Jira's own ceiling for a fields-bearing search. */
const SEARCH_PAGE_SIZE = 100;

/** A non-2xx answer from Jira, carrying the status so a caller can react to a
 *  specific one (a 400 means the request body was refused, not the request). */
class JiraRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JiraRequestError";
  }
}

/**
 * Determine if a fetch error should be retried. Transient failures (5xx, timeout,
 * network error) should retry; permanent failures (4xx, auth) should fail fast.
 */
function isRetriableError(error: unknown): boolean {
  // Retry 5xx and 429 (rate limit); do NOT retry 4xx (auth, not found, etc.).
  if (error instanceof JiraRequestError) {
    return error.status >= 500 || error.status === 429;
  }
  const message = error instanceof Error ? error.message : String(error);
  // Malformed JSON is deterministic, not transient — don't retry it.
  if (/returned invalid JSON/.test(message)) return false;
  // No status — a raw fetch/network throw. Retry with caution.
  return true;
}

/**
 * "acme.atlassian.net" or a pasted URL → "https://acme.atlassian.net".
 *
 * Restricted to Jira Cloud's own domain on purpose: this URL is fetched
 * server-side with the tenant's credentials attached and the response body
 * surfaces to the tenant, so accepting an arbitrary host would make an
 * `org:manage` principal able to read anything the API pod can reach — a link
 * local address, an internal service, a look-alike domain harvesting the
 * token. Self-hosted Data Center would need an explicit allowlist, not a
 * loosening of this.
 *
 * The one exception is opt-in and for a stand-in Jira on the developer's own
 * machine: `JIRA_ALLOW_LOCAL_SITE_URL` admits `http://localhost:<port>` and
 * `http://127.0.0.1:<port>`, nothing else. Off unless set, so a deployment
 * that never heard of it behaves exactly as before.
 */
const JIRA_CLOUD_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function localSiteUrlsAllowed(): boolean {
  try {
    return getSettings().jiraAllowLocalSiteUrl;
  } catch {
    // Settings not initialized (unit tests): the strict rule applies.
    return false;
  }
}

export function normalizeSiteUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid Jira site URL: ${input}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname) && localSiteUrlsAllowed()) {
    return `http://${hostname}${url.port ? `:${url.port}` : ""}`;
  }
  if (!JIRA_CLOUD_HOST.test(hostname)) {
    throw new Error(
      `Invalid Jira site URL: ${input} — expected <your-site>.atlassian.net`,
    );
  }
  return `https://${hostname}`;
}

/** A filter's JQL with its `ORDER BY` trimmed, so a caller can AND onto it. */
function stripOrderBy(jql: string): string {
  return jql.replace(/\s+order\s+by\s+[\s\S]*$/i, "").trim();
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

  /**
   * `idempotent: false` skips retrying — a timeout/network error can happen
   * after Jira already applied the write, so resubmitting a mutation (create
   * a comment, transition an issue) risks doing it twice. Reads and the
   * idempotent transition-status GET are safe to retry.
   */
  private async request<T>(
    path: string,
    init?: RequestInit,
    { idempotent = true }: { idempotent?: boolean } = {},
  ): Promise<T> {
    const attempt = async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let body: string;
      try {
        body = await response.text();
      } catch (cause) {
        // Distinct from a legit empty body: don't silently coerce to "".
        throw new Error(`Jira ${path} failed to read response body`, {
          cause,
        });
      }
      if (!response.ok) {
        throw new JiraRequestError(
          `Jira ${path} failed (${response.status}): ${body.slice(0, 300)}`,
          response.status,
        );
      }
      // Transition POSTs answer 204 with an empty body.
      if (body === "") return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch (cause) {
        throw new Error(
          `Jira ${path} returned invalid JSON: ${body.slice(0, 300)}`,
          { cause },
        );
      }
    };
    if (!idempotent) return attempt();
    return retry(attempt, {
      maxAttempts: 3,
      minTimeout: 100,
      maxTimeout: 5000,
      multiplier: 2,
      jitter: 1,
      isRetriable: isRetriableError,
    });
  }

  /** Cheapest authenticated call — used to validate credentials on save. */
  async myself(): Promise<{ accountId: string; displayName: string }> {
    return this.request("/rest/api/3/myself");
  }

  /**
   * Display names for up to `USER_LOOKUP_CHUNK` account ids per query — the
   * mention resolver. `/user/bulk` needs the "Browse users and groups" global
   * permission and answers 403 without it; it also omits ids it won't disclose
   * rather than erroring, so the result can be shorter than the input. Paged
   * because Jira clamps `maxResults` to its own ceiling, silently.
   */
  async listUsersByAccountId(
    accountIds: string[],
  ): Promise<Array<{ accountId: string; displayName: string }>> {
    if (accountIds.length === 0) return [];
    const users: Array<{ accountId: string; displayName: string }> = [];
    let startAt = 0;
    for (;;) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(accountIds.length),
      });
      for (const accountId of accountIds) query.append("accountId", accountId);
      const page = await this.request<{
        values?: Array<{ accountId: string; displayName: string }>;
        total?: number;
      }>(`/rest/api/3/user/bulk?${query}`);
      const values = page.values ?? [];
      users.push(...values);
      // `total` is the disclosed count, which is <= the ids asked for; an empty
      // page is the fallback signal if Jira omits it. `isLast` is not used —
      // it is optional in the response and absent means "stop" if trusted.
      const total =
        typeof page.total === "number" ? page.total : accountIds.length;
      if (values.length === 0 || users.length >= total) break;
      startAt += values.length;
    }
    return users;
  }

  /** Boards visible to the credentials — the board picker. */
  async listBoards(): Promise<JiraBoard[]> {
    const boards: JiraBoard[] = [];
    let startAt = 0;
    while (boards.length < 200) {
      const page = await this.request<{
        values: Array<{
          id: number;
          name: string;
          type: string;
          location?: { projectKey?: string; projectName?: string };
        }>;
        isLast: boolean;
      }>(`/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`);
      boards.push(
        ...page.values.map((board) => ({
          id: board.id,
          name: board.name,
          type: board.type,
          projectKey: board.location?.projectKey,
          projectName: board.location?.projectName,
        })),
      );
      if (page.isLast || page.values.length === 0) break;
      startAt += page.values.length;
    }
    return boards;
  }

  /** The board's columns with their status NAMES, in board order — what the
   *  settings UI shows (tenants know column names, not raw statuses). */
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

  /**
   * The JQL that defines what a board covers — its saved filter's own query,
   * with any `ORDER BY` trimmed so the caller can AND onto it.
   *
   * The filter, not `project = <the board's project>`: a board scoped to one
   * team inside a shared project, or spanning several projects, is only
   * described by its filter, and reading its whole project instead would
   * watch another team's issues.
   *
   * Which is why an unreadable filter FAILS rather than falling back to the
   * project — a filter can be shared with fewer people than the board it
   * drives, and the safe answer to "I can't see the scope" is to stop, not to
   * guess a wider one. The tenant sees the error and shares the filter. Only
   * a board with no filter at all (`/configuration` says so) is
   * scoped by its project, because then nothing narrower exists.
   */
  async getBoardScopeJql(boardId: string): Promise<string> {
    const id = assertBoardId(boardId);
    const config = await this.request<{ filter?: { id?: string } | null }>(
      `/rest/agile/1.0/board/${id}/configuration`,
    );
    const filterId = config.filter?.id;
    if (filterId && /^\d+$/.test(String(filterId))) {
      let jql: string;
      try {
        const filter = await this.request<{ jql?: string }>(
          `/rest/api/3/filter/${filterId}`,
        );
        jql = stripOrderBy(filter.jql ?? "");
      } catch (cause) {
        throw new Error(
          `Jira board ${id} is driven by filter ${filterId}, which these credentials cannot read — share that filter with the integration's account (reading the board's project instead would include issues that are not on this board)`,
          { cause },
        );
      }
      if (jql) return jql;
    }
    const board = await this.request<{
      location?: { projectKey?: string } | null;
    }>(`/rest/agile/1.0/board/${id}`);
    const projectKey = board.location?.projectKey;
    if (!projectKey) {
      throw new Error(
        `Jira board ${id} exposes neither a filter nor a project — nothing to watch`,
      );
    }
    return `project = ${JSON.stringify(projectKey)}`;
  }

  /**
   * One page of a JQL search, newest pagination (`nextPageToken`).
   *
   * `/rest/api/3/search/jql` has no `total` and no `startAt` — it walks a
   * cursor, which is also what makes it safe under a query ordered by `updated`
   * while issues are being updated: an offset would skip or repeat rows as the
   * result set shifts under it.
   */
  async searchIssues(params: {
    jql: string;
    nextPageToken?: string;
    /** Carry each issue's changelog, for a caller that needs its transitions. */
    expandChangelog?: boolean;
  }): Promise<{
    issues: Array<
      JiraIssue & { changelog?: { histories: JiraChangelogHistory[] } }
    >;
    nextPageToken: string | null;
  }> {
    const query = new URLSearchParams({
      jql: params.jql,
      maxResults: String(SEARCH_PAGE_SIZE),
      fields: ISSUE_FIELDS,
    });
    if (params.expandChangelog) query.set("expand", "changelog");
    if (params.nextPageToken) query.set("nextPageToken", params.nextPageToken);
    const page = await this.request<{
      issues?: Array<{
        id: string;
        key: string;
        fields: JiraIssueFields & Record<string, unknown>;
        changelog?: { histories: JiraChangelogHistory[] };
      }>;
      nextPageToken?: string | null;
    }>(`/rest/api/3/search/jql?${query}`);
    return {
      issues: page.issues ?? [],
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  /** One issue with what a run's opening message shows. */
  async getIssue(issueId: string): Promise<{
    id: string;
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      description: unknown;
      attachment?: JiraAttachment[];
    };
  }> {
    return this.request(
      `/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=summary,status,description,attachment`,
    );
  }

  /**
   * The bytes of one attachment, as the upstream response so a route can
   * stream them. Jira answers the content URL with a 303 to the media CDN;
   * `fetch` follows it, and the platform drops the Authorization header on
   * the cross-origin hop, which the CDN's signed URL does not need.
   */
  async downloadAttachment(attachmentId: string): Promise<Response> {
    return fetch(
      `${this.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
      {
        headers: { Authorization: this.authHeader },
        redirect: "follow",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      },
    );
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
      { idempotent: false },
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

  /**
   * Post a comment (as the credential's account). Returns the Jira id.
   *
   * `markdown` is a board comment, rendered to ADF so the issue shows
   * formatted text instead of raw `**syntax**`. `header` is prepended as its
   * own plain paragraph — it carries a tenant-supplied display name, which
   * must not be parsed as markup.
   *
   * A 400 is Jira refusing the document, so nothing was created and reposting
   * cannot duplicate: fall back once to the flat plain-text body rather than
   * losing the comment, since the write is deliberately non-retriable. Any
   * other status propagates.
   */
  async addComment(
    issueId: string,
    markdown: string,
    {
      header,
      media,
    }: { header?: string; media?: ReadonlyMap<string, AdfMedia> } = {},
  ): Promise<{ id: string }> {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`;
    const post = (body: unknown) =>
      this.request<{ id: string }>(
        path,
        { method: "POST", body: JSON.stringify({ body }) },
        { idempotent: false },
      );
    try {
      return await post(markdownToAdf(markdown, { header, media }));
    } catch (err) {
      if (!(err instanceof JiraRequestError) || err.status !== 400) throw err;
      console.warn(`[jira] comment rejected as ADF, posting flat: ${err}`);
      return post(textToAdf(header ? `${header}\n${markdown}` : markdown));
    }
  }

  /** Attachments on the issue. */
  async listAttachments(issueId: string): Promise<JiraAttachment[]> {
    const issue = await this.request<{
      fields?: { attachment?: JiraAttachment[] };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=attachment`);
    return issue.fields?.attachment ?? [];
  }
}

/** Plain text → minimal ADF: one paragraph per non-empty line. The fallback
 *  for a body `markdownToAdf` renders into something Jira refuses. */
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

interface MentionAttrs {
  id?: unknown;
  text?: unknown;
}

/** The display name ADF usually ships inside the mention itself (`"@Jane Doe"`),
 *  normalized without its `@`. Absent on mentions written through the API, and
 *  on some older bodies — those need the account-id lookup. */
function mentionLabel(attrs: MentionAttrs | undefined): string | null {
  const text = typeof attrs?.text === "string" ? attrs.text.trim() : "";
  const label = text.startsWith("@") ? text.slice(1).trim() : text;
  return label === "" ? null : label;
}

function mentionText(
  attrs: MentionAttrs | undefined,
  names: ReadonlyMap<string, string>,
): string {
  const label = mentionLabel(attrs);
  if (label) return `@${escapeMentionName(label)}`;
  const id = typeof attrs?.id === "string" ? attrs.id : "";
  const name = id ? names.get(id) : undefined;
  return name ? `@${escapeMentionName(name)}` : UNKNOWN_MENTION;
}

/** Account ids in a body that a name lookup has to resolve, so a run can batch
 *  them into one request instead of rendering opaque ids. Mentions that already
 *  carry their name (the common ADF case) contribute nothing. */
export function collectMentionAccountIds(body: unknown): string[] {
  const ids = new Set<string>();
  collectMentions(body, ids);
  return [...ids];
}

function collectMentions(body: unknown, ids: Set<string>): void {
  if (typeof body === "string") {
    for (const id of collectWikiMentionAccountIds(body)) ids.add(id);
    return;
  }
  if (!body || typeof body !== "object") return;
  const node = body as {
    type?: string;
    attrs?: MentionAttrs;
    content?: unknown[];
  };
  if (node.type === "mention") {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    if (id && !mentionLabel(node.attrs)) ids.add(id);
    return;
  }
  for (const child of Array.isArray(node.content) ? node.content : []) {
    collectMentions(child, ids);
  }
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown> & MentionAttrs;
  content?: unknown[];
}

function adfNode(value: unknown): AdfNode | null {
  return value && typeof value === "object" ? (value as AdfNode) : null;
}

function adfChildren(node: AdfNode): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function attrText(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * The inline run of a node: text, breaks, mentions, and the small widgets ADF
 * uses for links, emoji and dates.
 *
 * Marks (bold, links, code) are dropped: the card is a summary that links back
 * to the issue, and re-deriving `[text](href)` from mark ranges is a different
 * job from keeping the body readable. Anything unrecognized recurses, so a node
 * type Atlassian adds later still contributes its text instead of vanishing.
 */
function inlineText(
  value: unknown,
  names: ReadonlyMap<string, string>,
): string {
  const node = adfNode(value);
  if (!node) return "";
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return mentionText(node.attrs, names);
    case "emoji":
      return attrText(node, "text") || attrText(node, "shortName");
    case "inlineCard":
    case "blockCard":
      return attrText(node, "url");
    case "date":
      return attrText(node, "timestamp");
    case "status":
      return attrText(node, "text");
    default:
      return adfChildren(node)
        .map((child) => inlineText(child, names))
        .join("");
  }
}

/** Indent every line but the first, so a list item's second paragraph stays
 *  inside the item instead of ending it. Blank lines are left blank rather than
 *  padded — the separator between an item's paragraphs must not carry trailing
 *  whitespace. */
function hangingIndent(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : pad + line))
    .join("\n");
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : prefix + line))
    .join("\n");
}

/** One list, its items marked and their continuation lines indented under the
 *  marker. `marker` decides bullet vs number vs checkbox. */
function listText(
  node: AdfNode,
  names: ReadonlyMap<string, string>,
  marker: (item: AdfNode, index: number) => string,
): string {
  const items = adfChildren(node)
    .map(adfNode)
    .filter((item): item is AdfNode => item !== null);
  return items
    .map((item, index) => {
      const bullet = marker(item, index);
      const body = blockTexts(adfChildren(item), names).join("\n\n");
      return bullet + hangingIndent(body, bullet.length);
    })
    .join("\n");
}

/**
 * A table cell flattened to one line: a newline or a bare pipe would each break
 * the row apart, so they are folded and escaped rather than emitted.
 *
 * Backslashes are escaped BEFORE pipes, and the order is load-bearing. A cell
 * reading `a\|b` would otherwise come out as `a\\|b`, where markdown reads the
 * pair as one literal backslash and the pipe as a live column separator — the
 * exact break the escape exists to prevent.
 */
function cellText(value: unknown, names: ReadonlyMap<string, string>): string {
  const node = adfNode(value);
  if (!node) return "";
  return blockTexts(adfChildren(node), names)
    .join(" ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * An ADF table as a markdown one.
 *
 * The delimiter row goes under the first row whether or not it is made of
 * header cells: markdown has no way to render a table without one, and a body
 * row promoted to a header reads far better than a table that does not render.
 */
function tableText(node: AdfNode, names: ReadonlyMap<string, string>): string {
  const rows = adfChildren(node)
    .map(adfNode)
    .filter((row): row is AdfNode => row?.type === "tableRow")
    .map((row) => adfChildren(row).map((cell) => cellText(cell, names)));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
  const [header, ...body] = rows as [string[], ...string[][]];
  return [
    line(header),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/** The block-level nodes of one container, each rendered whole, with the empty
 *  ones dropped so a stray media node does not leave a blank paragraph. */
function blockTexts(
  values: unknown[],
  names: ReadonlyMap<string, string>,
): string[] {
  return values
    .map((value) => blockText(value, names))
    .filter((text) => text.trim() !== "");
}

/**
 * One block, rendered as the markdown the card's description field is written
 * in (that is already the contract — a v2 wiki body goes through
 * {@link wikiToMarkdown}).
 *
 * Every container that holds siblings has to say how they are separated. The
 * previous version answered that only for `doc` and concatenated everywhere
 * else, so a table came out as its cells run together and a list as its items
 * run together — the text was all present and none of it was readable.
 */
function blockText(value: unknown, names: ReadonlyMap<string, string>): string {
  const node = adfNode(value);
  if (!node) return "";
  switch (node.type) {
    case "doc":
      return blockTexts(adfChildren(node), names).join("\n\n");
    case "heading": {
      const level = Number(node.attrs?.level);
      const depth = Number.isInteger(level)
        ? Math.min(Math.max(level, 1), 6)
        : 1;
      return `${"#".repeat(depth)} ${inlineText(node, names)}`;
    }
    case "bulletList":
      return listText(node, names, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.order);
      const first = Number.isInteger(start) && start > 0 ? start : 1;
      return listText(node, names, (_item, index) => `${first + index}. `);
    }
    case "taskList":
      return listText(node, names, (item) =>
        attrText(item, "state") === "DONE" ? "- [x] " : "- [ ] ",
      );
    case "codeBlock":
      return `\`\`\`${attrText(node, "language")}\n${inlineText(node, names)}\n\`\`\``;
    case "blockquote":
    case "panel":
      return prefixLines(
        blockTexts(adfChildren(node), names).join("\n\n"),
        "> ",
      );
    case "rule":
      return "---";
    case "table":
      return tableText(node, names);
    case "expand":
    case "nestedExpand": {
      const title = attrText(node, "title").trim();
      const body = blockTexts(adfChildren(node), names).join("\n\n");
      return title ? `**${title}**\n\n${body}` : body;
    }
    case "media":
      return "";
    case "mediaSingle":
    case "mediaGroup":
      return blockTexts(adfChildren(node), names).join("\n\n");
    default:
      return inlineText(node, names);
  }
}

/** Jira rich body → the markdown a card's description is written in. The Agile
 *  API returns v2-style STRING bodies (wiki markup — converted by
 *  {@link wikiToMarkdown}); REST v3 returns an ADF tree, rendered block by
 *  block: headings, lists, task lists, code blocks, quotes and tables all keep
 *  their shape. ADF marks and media are dropped — the card links back to the
 *  issue for full fidelity. */
export function jiraBodyToText(
  adf: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (typeof adf === "string") return wikiToMarkdown(adf, names);
  if (!adf || typeof adf !== "object") return "";
  return blockText(adf, names);
}

/**
 * Account id → display name, resolved once per client.
 *
 * Unresolved ids are cached as such: a deleted account, or a credential
 * without the "Browse users and groups" global permission, must not re-cost a
 * request for every issue that mentions it. A lookup failure degrades the text
 * to `@unknown` — it never fails the read, which would strand every other
 * field over a cosmetic detail.
 */
export class JiraUserDirectory {
  private readonly names = new Map<string, string | null>();
  private lookupsDisabled = false;

  constructor(private readonly client: JiraClient) {}

  async resolve(accountIds: string[]): Promise<ReadonlyMap<string, string>> {
    const missing = this.lookupsDisabled
      ? []
      : [...new Set(accountIds.filter((id) => !this.names.has(id)))];
    for (let at = 0; at < missing.length; at += USER_LOOKUP_CHUNK) {
      const chunk = missing.slice(at, at + USER_LOOKUP_CHUNK);
      // Seeded before the call so ids Jira silently omits aren't re-requested.
      for (const id of chunk) this.names.set(id, null);
      try {
        for (const user of await this.client.listUsersByAccountId(chunk)) {
          if (user.displayName)
            this.names.set(user.accountId, user.displayName);
        }
      } catch (err) {
        // Latched, not retried per id: a credential without the permission
        // would otherwise cost one failing round-trip per mentioned account.
        this.lookupsDisabled = true;
        console.warn(
          "[jira] user lookup failed, mentions render as @unknown for this run:",
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
    const resolved = new Map<string, string>();
    for (const id of accountIds) {
      const name = this.names.get(id);
      if (name) resolved.set(id, name);
    }
    return resolved;
  }
}
