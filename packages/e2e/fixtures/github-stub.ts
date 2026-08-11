/**
 * In-memory GitHub Git Data API stub for the sandbox-less decofile e2e suite.
 *
 * The studio server's decofile routes talk to GitHub exclusively through the
 * Git Data (+ merges/pulls/compare) endpoints, all rooted at
 * `GITHUB_API_BASE_URL`. Pointing that env at this stub lets the whole
 * read/patch/publish/status surface run hermetically — tests must never reach
 * api.github.com.
 *
 * Black-box: the studio server reaches this over HTTP only — no app imports.
 * Uses `node:http` (NOT `Bun.serve`) so it typechecks under the suite's Node
 * types and runs under either node or bun (same rationale as
 * commerce-upgrade-mock.ts).
 *
 * Git model (per "owner/repo"):
 *   - blobs:   content-addressed utf-8 strings
 *   - trees:   flat `path -> blobSha` maps (recursive listing is trivial)
 *   - commits: `{treeSha, parents, message}` with deterministic 40-hex shas
 *   - refs:    `branch -> commitSha`
 *
 * GitHub-shaped endpoints (only what the decofile client calls):
 *   GET   /repos/{o}/{r}                              -> { default_branch }
 *   GET   /repos/{o}/{r}/git/ref/heads/{branch}       -> { object: { sha } }
 *   GET   /repos/{o}/{r}/git/commits/{sha}            -> { tree: { sha }, parents }
 *   GET   /repos/{o}/{r}/git/trees/{sha}?recursive=1  -> { tree: [...], truncated }
 *   GET   /repos/{o}/{r}/git/blobs/{sha}              -> { content, encoding }
 *   POST  /repos/{o}/{r}/git/blobs                    -> { sha }
 *   POST  /repos/{o}/{r}/git/trees                    -> { sha } (entry sha:null deletes)
 *   POST  /repos/{o}/{r}/git/commits                  -> { sha }
 *   PATCH /repos/{o}/{r}/git/refs/heads/{branch}      -> 200 (422 non-fast-forward)
 *   POST  /repos/{o}/{r}/merges                       -> 201 {sha} / 204 / 409 / 405
 *   GET   /repos/{o}/{r}/pulls?state&base&head        -> [ { number, html_url } ]
 *   POST  /repos/{o}/{r}/pulls                        -> { number, html_url }
 *   GET   /repos/{o}/{r}/compare/{base}...{head}      -> { ahead_by, behind_by }
 *
 * Test-only admin endpoints (no auth):
 *   GET  /health
 *   POST /__admin/repos                    seed a repo (see SeedRepoBody)
 *   GET  /__admin/repos/{o}/{r}            inspect refs/commits/files per branch
 *   POST /__admin/repos/{o}/{r}/config     { mergeMode } — flip merge behavior
 */

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

type MergeMode = "merge" | "conflict" | "blocked";

interface CommitRecord {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
}

interface PullRecord {
  number: number;
  base: string;
  head: string;
  title: string;
  state: "open" | "closed";
  html_url: string;
}

interface RepoState {
  owner: string;
  name: string;
  defaultBranch: string;
  mergeMode: MergeMode;
  /** branch -> head commit sha */
  refs: Map<string, string>;
  commits: Map<string, CommitRecord>;
  /** Insertion-ordered commit shas, for log inspection. */
  commitLog: string[];
  /** treeSha -> (path -> blobSha) */
  trees: Map<string, Map<string, string>>;
  /** blobSha -> utf-8 content */
  blobs: Map<string, string>;
  pulls: PullRecord[];
  nextPullNumber: number;
}

interface SeedRepoBody {
  owner: string;
  repo: string;
  defaultBranch?: string;
  /**
   * Per-branch file map (`path -> content`). The default branch becomes a root
   * commit; every other branch becomes ONE commit on top of the default head
   * (i.e. ahead-by-1). A branch entry WITHOUT a `files` key aliases the
   * default head instead (ahead-by-0) — handy for drift/status tests.
   */
  branches?: Record<string, { files?: Record<string, string> } | null>;
  mergeMode?: MergeMode;
}

const repos = new Map<string, RepoState>();
let commitCounter = 0;

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function putBlob(repo: RepoState, content: string): string {
  const sha = sha1(`blob:${content}`);
  repo.blobs.set(sha, content);
  return sha;
}

function putTree(repo: RepoState, files: Map<string, string>): string {
  const serialized = JSON.stringify([...files.entries()].sort());
  const sha = sha1(`tree:${serialized}`);
  repo.trees.set(sha, new Map(files));
  return sha;
}

function putCommit(
  repo: RepoState,
  treeSha: string,
  parents: string[],
  message: string,
): string {
  // The counter keeps same-(tree,parents,message) commits distinct — this is
  // fixture code, not git; determinism-per-run is all the tests need.
  const sha = sha1(
    `commit:${treeSha}:${parents.join(",")}:${message}:${commitCounter++}`,
  );
  repo.commits.set(sha, { sha, treeSha, parents, message });
  repo.commitLog.push(sha);
  return sha;
}

/** All commit shas reachable from `sha` (inclusive) via parent edges. */
function reachableFrom(repo: RepoState, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const commit = repo.commits.get(current);
    if (commit) stack.push(...commit.parents);
  }
  return seen;
}

function isAncestor(
  repo: RepoState,
  ancestor: string,
  descendant: string,
): boolean {
  return reachableFrom(repo, descendant).has(ancestor);
}

function treeOfCommit(repo: RepoState, commitSha: string): Map<string, string> {
  const commit = repo.commits.get(commitSha);
  const tree = commit ? repo.trees.get(commit.treeSha) : undefined;
  return tree ?? new Map();
}

function filesAtCommit(
  repo: RepoState,
  commitSha: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, blobSha] of treeOfCommit(repo, commitSha)) {
    out[path] = repo.blobs.get(blobSha) ?? "";
  }
  return out;
}

/**
 * Most-recent common ancestor of two heads: a common commit no OTHER common
 * commit descends from. Repos here are tiny linear seeds, so brute force wins.
 */
function mergeBaseOf(repo: RepoState, a: string, b: string): string | null {
  const ra = reachableFrom(repo, a);
  const common = [...reachableFrom(repo, b)].filter((sha) => ra.has(sha));
  return (
    common.find(
      (c) => !common.some((d) => d !== c && isAncestor(repo, c, d)),
    ) ?? null
  );
}

function seedRepo(body: SeedRepoBody): RepoState {
  const defaultBranch = body.defaultBranch ?? "main";
  const repo: RepoState = {
    owner: body.owner,
    name: body.repo,
    defaultBranch,
    mergeMode: body.mergeMode ?? "merge",
    refs: new Map(),
    commits: new Map(),
    commitLog: [],
    trees: new Map(),
    blobs: new Map(),
    pulls: [],
    nextPullNumber: 1,
  };

  const branches = body.branches ?? {};
  const defaultFiles = branches[defaultBranch]?.files ?? {};
  const defaultTree = putTree(
    repo,
    new Map(
      Object.entries(defaultFiles).map(([path, content]) => [
        path,
        putBlob(repo, content),
      ]),
    ),
  );
  const defaultHead = putCommit(repo, defaultTree, [], `seed ${defaultBranch}`);
  repo.refs.set(defaultBranch, defaultHead);

  for (const [branch, spec] of Object.entries(branches)) {
    if (branch === defaultBranch) continue;
    if (!spec || spec.files === undefined) {
      repo.refs.set(branch, defaultHead); // alias: same head, zero drift
      continue;
    }
    const tree = putTree(
      repo,
      new Map(
        Object.entries(spec.files).map(([path, content]) => [
          path,
          putBlob(repo, content),
        ]),
      ),
    );
    repo.refs.set(
      branch,
      putCommit(repo, tree, [defaultHead], `seed ${branch}`),
    );
  }
  repos.set(repoKey(body.owner, body.repo), repo);
  return repo;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
}

function notFound(res: ServerResponse): void {
  json(res, 404, { message: "Not Found" });
}

/** Decoded path segments; branch names may span several (slashes preserved). */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const segments = segmentsOf(url.pathname);
  // POST /__admin/repos
  if (
    req.method === "POST" &&
    segments.length === 2 &&
    segments[1] === "repos"
  ) {
    const body = JSON.parse((await readBody(req)) || "{}") as SeedRepoBody;
    if (!body.owner || !body.repo) {
      json(res, 400, { message: "owner and repo are required" });
      return;
    }
    const repo = seedRepo(body);
    json(res, 200, {
      owner: repo.owner,
      repo: repo.name,
      defaultBranch: repo.defaultBranch,
      refs: Object.fromEntries(repo.refs),
    });
    return;
  }

  // /__admin/repos/{owner}/{repo}[/config]
  const owner = segments[2];
  const name = segments[3];
  const repo = owner && name ? repos.get(repoKey(owner, name)) : undefined;
  if (!repo) {
    notFound(res);
    return;
  }

  if (req.method === "POST" && segments[4] === "config") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      mergeMode?: MergeMode;
    };
    if (body.mergeMode) repo.mergeMode = body.mergeMode;
    json(res, 200, { mergeMode: repo.mergeMode });
    return;
  }

  if (req.method === "GET" && segments.length === 4) {
    json(res, 200, {
      defaultBranch: repo.defaultBranch,
      mergeMode: repo.mergeMode,
      refs: Object.fromEntries(repo.refs),
      commits: repo.commitLog.map((sha) => {
        const c = repo.commits.get(sha);
        return { sha, message: c?.message ?? "", parents: c?.parents ?? [] };
      }),
      branches: Object.fromEntries(
        [...repo.refs.entries()].map(([branch, sha]) => [
          branch,
          { headSha: sha, files: filesAtCommit(repo, sha) },
        ]),
      ),
    });
    return;
  }

  notFound(res);
}

async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!req.headers.authorization) {
    json(res, 401, { message: "Requires authentication" });
    return;
  }

  const segments = segmentsOf(url.pathname);
  const owner = segments[1];
  const name = segments[2];
  const repo = owner && name ? repos.get(repoKey(owner, name)) : undefined;
  if (!repo) {
    notFound(res);
    return;
  }
  const rest = segments.slice(3);

  // GET /repos/{o}/{r}
  if (req.method === "GET" && rest.length === 0) {
    json(res, 200, {
      name: repo.name,
      full_name: repoKey(repo.owner, repo.name),
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
    });
    return;
  }

  // GET /repos/{o}/{r}/git/ref/heads/{branch...}
  if (
    req.method === "GET" &&
    rest[0] === "git" &&
    rest[1] === "ref" &&
    rest[2] === "heads"
  ) {
    const branch = rest.slice(3).join("/");
    const sha = repo.refs.get(branch);
    if (!sha) {
      notFound(res);
      return;
    }
    json(res, 200, {
      ref: `refs/heads/${branch}`,
      object: { type: "commit", sha },
    });
    return;
  }

  // GET /repos/{o}/{r}/git/commits/{sha}
  if (
    req.method === "GET" &&
    rest[0] === "git" &&
    rest[1] === "commits" &&
    rest.length === 3
  ) {
    const commit = rest[2] ? repo.commits.get(rest[2]) : undefined;
    if (!commit) {
      notFound(res);
      return;
    }
    json(res, 200, {
      sha: commit.sha,
      message: commit.message,
      tree: { sha: commit.treeSha },
      parents: commit.parents.map((sha) => ({ sha })),
    });
    return;
  }

  // GET /repos/{o}/{r}/git/trees/{sha}
  if (
    req.method === "GET" &&
    rest[0] === "git" &&
    rest[1] === "trees" &&
    rest.length === 3
  ) {
    const tree = rest[2] ? repo.trees.get(rest[2]) : undefined;
    if (!tree) {
      notFound(res);
      return;
    }
    json(res, 200, {
      sha: rest[2],
      truncated: false,
      tree: [...tree.entries()].map(([path, blobSha]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: blobSha,
      })),
    });
    return;
  }

  // GET /repos/{o}/{r}/git/blobs/{sha}
  if (
    req.method === "GET" &&
    rest[0] === "git" &&
    rest[1] === "blobs" &&
    rest.length === 3
  ) {
    const content = rest[2] ? repo.blobs.get(rest[2]) : undefined;
    if (content === undefined) {
      notFound(res);
      return;
    }
    json(res, 200, {
      sha: rest[2],
      content: Buffer.from(content, "utf-8").toString("base64"),
      encoding: "base64",
    });
    return;
  }

  // POST /repos/{o}/{r}/git/blobs
  if (
    req.method === "POST" &&
    rest[0] === "git" &&
    rest[1] === "blobs" &&
    rest.length === 2
  ) {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      content?: string;
      encoding?: string;
    };
    if (typeof body.content !== "string" || body.encoding !== "utf-8") {
      json(res, 422, { message: "content (utf-8) is required" });
      return;
    }
    json(res, 201, { sha: putBlob(repo, body.content) });
    return;
  }

  // POST /repos/{o}/{r}/git/trees
  if (
    req.method === "POST" &&
    rest[0] === "git" &&
    rest[1] === "trees" &&
    rest.length === 2
  ) {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      base_tree?: string;
      tree?: Array<{ path: string; sha: string | null }>;
    };
    const base = body.base_tree
      ? repo.trees.get(body.base_tree)
      : new Map<string, string>();
    if (!base) {
      notFound(res);
      return;
    }
    const files = new Map(base);
    for (const entry of body.tree ?? []) {
      if (entry.sha === null) {
        files.delete(entry.path);
        continue;
      }
      if (!repo.blobs.has(entry.sha)) {
        json(res, 404, { message: `blob ${entry.sha} not found` });
        return;
      }
      files.set(entry.path, entry.sha);
    }
    json(res, 201, { sha: putTree(repo, files) });
    return;
  }

  // POST /repos/{o}/{r}/git/commits
  if (
    req.method === "POST" &&
    rest[0] === "git" &&
    rest[1] === "commits" &&
    rest.length === 2
  ) {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      message?: string;
      tree?: string;
      parents?: string[];
    };
    if (!body.tree || !repo.trees.has(body.tree)) {
      json(res, 404, { message: "tree not found" });
      return;
    }
    for (const parent of body.parents ?? []) {
      if (!repo.commits.has(parent)) {
        json(res, 404, { message: `parent ${parent} not found` });
        return;
      }
    }
    json(res, 201, {
      sha: putCommit(repo, body.tree, body.parents ?? [], body.message ?? ""),
    });
    return;
  }

  // PATCH /repos/{o}/{r}/git/refs/heads/{branch...}
  if (
    req.method === "PATCH" &&
    rest[0] === "git" &&
    rest[1] === "refs" &&
    rest[2] === "heads"
  ) {
    const branch = rest.slice(3).join("/");
    const current = repo.refs.get(branch);
    const body = JSON.parse((await readBody(req)) || "{}") as {
      sha?: string;
      force?: boolean;
    };
    if (!current || !body.sha || !repo.commits.has(body.sha)) {
      json(res, 422, { message: "Reference does not exist" });
      return;
    }
    if (
      !body.force &&
      body.sha !== current &&
      !isAncestor(repo, current, body.sha)
    ) {
      json(res, 422, { message: "Update is not a fast forward" });
      return;
    }
    repo.refs.set(branch, body.sha);
    json(res, 200, {
      ref: `refs/heads/${branch}`,
      object: { type: "commit", sha: body.sha },
    });
    return;
  }

  // POST /repos/{o}/{r}/merges
  if (req.method === "POST" && rest[0] === "merges" && rest.length === 1) {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      base?: string;
      head?: string;
      commit_message?: string;
    };
    const baseSha = body.base ? repo.refs.get(body.base) : undefined;
    const headSha = body.head ? repo.refs.get(body.head) : undefined;
    if (!baseSha || !headSha) {
      notFound(res);
      return;
    }
    if (isAncestor(repo, headSha, baseSha)) {
      json(res, 204); // base already contains head
      return;
    }
    if (repo.mergeMode === "conflict") {
      json(res, 409, { message: "Merge conflict" });
      return;
    }
    if (repo.mergeMode === "blocked") {
      json(res, 405, { message: "Base branch is protected" });
      return;
    }
    // Apply head's diff-since-merge-base onto base (head wins) — enough merge
    // fidelity for decofile publishes; conflicts are simulated via mergeMode.
    const mergeBase = mergeBaseOf(repo, baseSha, headSha);
    const merged = new Map(treeOfCommit(repo, baseSha));
    const headFiles = treeOfCommit(repo, headSha);
    const baseFiles = mergeBase
      ? treeOfCommit(repo, mergeBase)
      : new Map<string, string>();
    for (const path of new Set([...headFiles.keys(), ...baseFiles.keys()])) {
      const inHead = headFiles.get(path);
      if (inHead === baseFiles.get(path)) continue; // unchanged on head
      if (inHead === undefined) merged.delete(path);
      else merged.set(path, inHead);
    }
    const mergeSha = putCommit(
      repo,
      putTree(repo, merged),
      [baseSha, headSha],
      body.commit_message ?? `Merge ${body.head} into ${body.base}`,
    );
    repo.refs.set(body.base as string, mergeSha);
    json(res, 201, { sha: mergeSha, merged: true });
    return;
  }

  // GET /repos/{o}/{r}/pulls
  if (req.method === "GET" && rest[0] === "pulls" && rest.length === 1) {
    const state = url.searchParams.get("state");
    const base = url.searchParams.get("base");
    const head = url.searchParams.get("head"); // "owner:branch"
    const matches = repo.pulls.filter(
      (pr) =>
        (!state || pr.state === state) &&
        (!base || pr.base === base) &&
        (!head || `${repo.owner}:${pr.head}` === head),
    );
    json(
      res,
      200,
      matches.map((pr) => ({ number: pr.number, html_url: pr.html_url })),
    );
    return;
  }

  // POST /repos/{o}/{r}/pulls
  if (req.method === "POST" && rest[0] === "pulls" && rest.length === 1) {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      base?: string;
      head?: string;
      title?: string;
    };
    if (!body.base || !body.head) {
      json(res, 422, { message: "base and head are required" });
      return;
    }
    const pull: PullRecord = {
      number: repo.nextPullNumber++,
      base: body.base,
      head: body.head,
      title: body.title ?? "",
      state: "open",
      html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${repo.nextPullNumber - 1}`,
    };
    repo.pulls.push(pull);
    json(res, 201, { number: pull.number, html_url: pull.html_url });
    return;
  }

  // GET /repos/{o}/{r}/compare/{base}...{head}
  if (req.method === "GET" && rest[0] === "compare") {
    // Re-derive from the RAW pathname: branch segments are encoded and may
    // contain "/", so split on the literal "..." before decoding each side.
    const rawSpec = url.pathname.split("/compare/")[1] ?? "";
    const [rawBase, rawHead] = rawSpec.split("...");
    const decodePath = (raw: string | undefined): string =>
      (raw ?? "").split("/").map(decodeURIComponent).join("/");
    const baseSha = repo.refs.get(decodePath(rawBase));
    const headSha = repo.refs.get(decodePath(rawHead));
    if (!baseSha || !headSha) {
      notFound(res);
      return;
    }
    const baseReach = reachableFrom(repo, baseSha);
    const headReach = reachableFrom(repo, headSha);
    json(res, 200, {
      ahead_by: [...headReach].filter((sha) => !baseReach.has(sha)).length,
      behind_by: [...baseReach].filter((sha) => !headReach.has(sha)).length,
    });
    return;
  }

  notFound(res);
}

export function createGithubStubServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const dispatch = async (): Promise<void> => {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/__admin/")) {
        await handleAdmin(req, res, url);
        return;
      }
      if (url.pathname.startsWith("/repos/")) {
        await handleRepos(req, res, url);
        return;
      }
      notFound(res);
    };
    dispatch().catch((error) => {
      json(res, 500, {
        message: error instanceof Error ? error.message : "stub failure",
      });
    });
  });
}
