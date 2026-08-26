/**
 * Thin Jira Cloud client (Basic auth: email + API token).
 *
 * Deliberately not an SDK: the integration needs a handful of endpoints.
 *
 * Issue reads go through JQL search over the board's SAVED FILTER
 * ({@link JiraClient.getBoardScopeJql}), not through the Agile API's
 * `/board/{id}/issue`. That endpoint answers "what is on the board", which
 * silently excludes whatever sits in the board's Backlog tab — so an issue a
 * team files and leaves in the backlog (the normal way work arrives) was
 * invisible to the sync, and the watermark moved straight past it. The filter
 * is the board's own definition of its scope, backlog included; which sprint an
 * issue is in is data on the issue, and belongs on the card rather than
 * deciding whether the card exists.
 */

import { retry } from "@decocms/shared/std";
import { type AdfMedia, markdownToAdf } from "./markdown-adf";
import {
  findSprintFieldIds,
  type JiraSprintRef,
  parseSprintRefs,
  stripOrderBy,
} from "./sprint-field";
import {
  collectWikiMentionAccountIds,
  escapeMentionName,
  UNKNOWN_MENTION,
  wikiToMarkdown,
} from "./wiki-markdown";

const REQUEST_TIMEOUT_MS = 15_000;

/** Attachment uploads carry screenshot bytes, so they get their own budget —
 *  a QA run's PNG is orders of magnitude larger than any JSON call here. */
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
  /** Sprints this issue is in, oldest first — parsed out of the site's Sprint
   *  custom field. Empty when the site has no sprints, or the issue is in none. */
  sprints: JiraSprintRef[];
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

/** Sprint fields asked for per search. One per team-managed project, so a big
 *  site has many; past this the URL grows for fields no synced board uses. */
const MAX_SPRINT_FIELDS = 20;

/** Sprints read off one board — bounds a decade of history on a busy board. */
const MAX_BOARD_SPRINTS = 500;

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

  /**
   * The JQL that defines what a board covers — its saved filter's own query,
   * with any `ORDER BY` trimmed so the caller can AND onto it.
   *
   * The filter, not `project = <the board's project>`: a board scoped to one
   * team inside a shared project, or spanning several projects, is only
   * described by its filter, and pulling its whole project instead would put
   * another team's issues on the customer's board.
   *
   * Which is why an unreadable filter FAILS rather than falling back to the
   * project — a filter can be shared with fewer people than the board it
   * drives, and the safe answer to "I can't see the scope" is to stop, not to
   * guess a wider one. The tenant sees it in `last_sync_error` and shares the
   * filter. Only a board with no filter at all (`/configuration` says so) is
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
          `Jira board ${id} is driven by filter ${filterId}, which these credentials cannot read — share that filter with the integration's account (syncing the board's project instead would pull in issues that are not on this board)`,
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
        `Jira board ${id} exposes neither a filter nor a project — nothing to sync`,
      );
    }
    return `project = ${JSON.stringify(projectKey)}`;
  }

  /**
   * Every Sprint custom field on the site, resolved once per client.
   *
   * Plural because Sprint is per-project on Cloud: each team-managed project
   * gets its own, so picking one and reading it off every issue would report
   * "no sprint" for every card on a board driven by a different project's
   * field. All of them are requested and whichever the issue carries wins.
   *
   * Cached as a promise so concurrent callers cost one request. NOT
   * error-swallowing: an empty list means "this site has no sprints", and
   * pretending a failed lookup means the same thing would clear the sprint of
   * every card the run touches.
   */
  private sprintFieldsPromise: Promise<string[]> | null = null;

  sprintFieldIds(): Promise<string[]> {
    this.sprintFieldsPromise ??= this.request<
      Array<{ id: string; schema?: { custom?: string } | null }>
    >("/rest/api/3/field").then((fields) => {
      const ids = findSprintFieldIds(fields);
      if (ids.length > MAX_SPRINT_FIELDS) {
        console.warn(
          `[jira] site has ${ids.length} Sprint fields; reading the first ${MAX_SPRINT_FIELDS}, so cards driven by the rest will sync without a sprint`,
        );
      }
      return ids.slice(0, MAX_SPRINT_FIELDS);
    });
    return this.sprintFieldsPromise;
  }

  /**
   * Every sprint the board knows about, so a sprint that closed in Jira reads
   * as closed here even when no issue in it changed.
   *
   * Deriving the mirror from the issues alone cannot do that: a sprint's state
   * would only refresh when one of its issues happened to land in the
   * watermark window, leaving a finished sprint labelled "current" forever.
   *
   * Empty for a board with no sprint support — Jira answers 400 to
   * `/board/{id}/sprint` on a Kanban board, which is an answer, not a failure.
   */
  async listBoardSprints(boardId: string): Promise<JiraSprintRef[]> {
    const id = assertBoardId(boardId);
    const sprints: JiraSprintRef[] = [];
    let startAt = 0;
    while (sprints.length < MAX_BOARD_SPRINTS) {
      let page: { values?: unknown[]; isLast?: boolean };
      try {
        page = await this.request<{ values?: unknown[]; isLast?: boolean }>(
          `/rest/agile/1.0/board/${id}/sprint?startAt=${startAt}&maxResults=50`,
        );
      } catch (err) {
        if (err instanceof JiraRequestError && err.status === 400) return [];
        throw err;
      }
      const values = page.values ?? [];
      sprints.push(...parseSprintRefs(values));
      startAt += values.length;
      if (page.isLast !== false || values.length === 0) break;
    }
    return sprints;
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
  }): Promise<{ issues: JiraIssue[]; nextPageToken: string | null }> {
    const sprintFields = await this.sprintFieldIds();
    const query = new URLSearchParams({
      jql: params.jql,
      maxResults: String(SEARCH_PAGE_SIZE),
      fields: [ISSUE_FIELDS, ...sprintFields].join(","),
    });
    if (params.nextPageToken) query.set("nextPageToken", params.nextPageToken);
    const page = await this.request<{
      issues?: Array<{
        id: string;
        key: string;
        fields: JiraIssueFields & Record<string, unknown>;
      }>;
      nextPageToken?: string | null;
    }>(`/rest/api/3/search/jql?${query}`);
    return {
      issues: (page.issues ?? []).map((issue) => ({
        ...issue,
        // First field that carries any sprint: only the issue's own project's
        // Sprint field is populated, the rest come back null.
        sprints:
          sprintFields
            .map((field) => parseSprintRefs(issue.fields[field]))
            .find((refs) => refs.length > 0) ?? [],
      })),
      nextPageToken: page.nextPageToken ?? null,
    };
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
   * losing the mirror, since the push step is deliberately non-retriable. Any
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

  /** Attachments already on the issue — the dedup check for a re-push. */
  async listAttachments(
    issueId: string,
  ): Promise<Array<{ id: string; filename: string; size: number }>> {
    const issue = await this.request<{
      fields?: {
        attachment?: Array<{ id: string; filename: string; size: number }>;
      };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=attachment`);
    return issue.fields?.attachment ?? [];
  }

  /**
   * Upload a file to the issue and return what an ADF `media` node needs.
   *
   * Two calls, because Jira splits the ids: the upload answers with a numeric
   * attachment id, while `media.attrs.id` is a media-services uuid that no
   * response body carries. `GET /attachment/content/{id}` answers 303 to
   * `https://api.media.atlassian.com/file/<uuid>/binary`, which is where the
   * uuid comes from.
   *
   * Not retried: Jira has no idempotency key for an upload either, so a
   * resubmit after a lost response duplicates the file on the customer's issue.
   * `mediaId` is null when the redirect does not yield a uuid — the caller then
   * keeps the image as a link instead of failing the comment.
   */
  async addAttachment(
    issueId: string,
    file: { name: string; bytes: Uint8Array; contentType?: string },
  ): Promise<{ attachmentId: string; mediaId: string | null }> {
    const form = new FormData();
    form.append(
      "file",
      // Copied: `Blob` needs an ArrayBuffer-backed view; org-fs returns wider.
      new Blob([new Uint8Array(file.bytes)], {
        type: file.contentType ?? "application/octet-stream",
      }),
      file.name,
    );
    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/attachments`,
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          // Jira refuses an unbrowsered multipart POST without this.
          "X-Atlassian-Token": "no-check",
        },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new JiraRequestError(
        `Jira attachment upload failed (${response.status}): ${body.slice(0, 300)}`,
        response.status,
      );
    }
    const uploaded = JSON.parse(body) as Array<{ id?: string }>;
    const attachmentId = uploaded[0]?.id;
    if (!attachmentId) {
      throw new Error("Jira attachment upload returned no id");
    }
    return { attachmentId, mediaId: await this.resolveMediaId(attachmentId) };
  }

  /**
   * Numeric attachment id → media-services uuid, read off the content
   * redirect. `redirect: "manual"` exposes the `location` header on Bun and
   * Node; the spec allows hiding it, so a followed HEAD (whose final `url` is
   * the same media URL, and which transfers no body) is the fallback.
   */
  async resolveMediaId(attachmentId: string): Promise<string | null> {
    const url = `${this.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
    const headers = { Authorization: this.authHeader };
    const uuidFrom = (candidate: string | null | undefined) =>
      candidate?.match(/\/file\/([0-9a-f-]{36})\//i)?.[1] ?? null;
    try {
      const redirect = await fetch(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const located = uuidFrom(redirect.headers.get("location"));
      if (located) return located;
      const followed = await fetch(url, {
        method: "HEAD",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return uuidFrom(followed.url);
    } catch (err) {
      console.warn(
        `[jira] could not resolve the media id for attachment ${attachmentId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
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

/** Jira rich body → text the cards can render. The Agile API returns
 *  v2-style STRING bodies (wiki markup — converted to markdown); REST v3
 *  returns an ADF tree, which is flattened: text nodes concatenated,
 *  doc-level blocks separated by blank lines. ADF marks, tables, and media
 *  are dropped — the card links back to the issue for full fidelity. */
export function jiraBodyToText(
  adf: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (typeof adf === "string") return wikiToMarkdown(adf, names);
  if (!adf || typeof adf !== "object") return "";
  const node = adf as {
    type?: string;
    text?: string;
    attrs?: MentionAttrs;
    content?: unknown[];
  };
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionText(node.attrs, names);
  const inner = (Array.isArray(node.content) ? node.content : []).map((child) =>
    jiraBodyToText(child, names),
  );
  if (node.type === "doc") {
    return inner.filter((text) => text.trim() !== "").join("\n\n");
  }
  return inner.join("");
}

/**
 * Account id → display name, resolved once per sync run.
 *
 * Unresolved ids are cached as such: a deleted account, or a credential
 * without the "Browse users and groups" global permission, must not re-cost a
 * request for every issue that mentions it. A lookup failure degrades the text
 * to `@unknown` — it never fails the sync, which would strand every other
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
