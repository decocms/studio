/**
 * How a run reads the store's code (adapters/repo.ts opens it), and the owned gap when it cannot.
 * The snapshot and `need_files` use mirror paths (`src/` dropped); the theme uses the repo's paths as they are.
 * The tree is read once per view and resolves both: `X` first, then `src/X`.
 */

import {
  GitProviderError,
  MAX_FILE_BYTES,
  MAX_TREE_ENTRIES,
  type RepoInsightsClient,
  type RepoTreeListing,
} from "@/git-providers";
import type { FsLister, RepoEntry, RepoReader } from "../ports.ts";
import type { SourceGap } from "../types.ts";
import type { RepoIdentity, RepoProvider } from "./studio-repo.ts";

/** One reading of the repo: both ways of seeing its paths. */
export interface CodeView {
  /** How the repo appears in reports (`owner/name`, host-prefixed off github.com). */
  repo: string;
  /** Mirror paths (`src/` dropped): the snapshot and `need_files`. */
  read: RepoReader;
  list: FsLister;
  /** The repo's paths as they are: the theme (code-tokens.ts). */
  raw: { read: RepoReader; list: FsLister };
  /** Files over the read ceiling, left out. */
  skipped(): string[];
}

export type CodeAccess =
  | {
      kind: "ready";
      repo: string;
      provider: RepoProvider;
      /** Throws `CodeGapError` when the repository cannot be read, with the reason. */
      open(): Promise<CodeView>;
    }
  | { kind: "gap"; gap: SourceGap };

/** The repository cannot be read, for a reason someone owns. */
export class CodeGapError extends Error {
  constructor(readonly gap: SourceGap) {
    super(gap.error);
  }
}

/** Prefix of every gap about the store's code. */
export const CODE_UNAVAILABLE = "código indisponível";

const PROVIDER_NAME: Record<RepoProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

const unavailable = (error: string, owner?: SourceGap["owner"]): SourceGap => ({
  source: "github",
  error: `${CODE_UNAVAILABLE}: ${error}`,
  ...(owner === "customer" ? { owner, key: "repository" as const } : {}),
  ...(owner === "external" ? { owner } : {}),
});

export const noRepositoryGap = (): SourceGap =>
  unavailable(
    "o projeto do site no Studio não tem repositório ligado",
    "customer",
  );

export const notLinkedGap = (repo: string): SourceGap =>
  unavailable(
    `o repositório ${repo} não está ligado a esta org no Studio`,
    "customer",
  );

const reconnectGap = (provider: RepoProvider, repo: string): SourceGap =>
  unavailable(
    `a conexão do Studio com o ${PROVIDER_NAME[provider]} não lê mais o repositório ${repo}: reconecte o ${PROVIDER_NAME[provider]} no Studio`,
    "customer",
  );

/** Why the linked repository cannot be read (`repositoryUsability` in adapters/repo-usability.ts). */
export function unusableGap(
  reason: string,
  provider: RepoProvider,
  repo: string,
): SourceGap {
  const name = PROVIDER_NAME[provider];
  switch (reason) {
    case "no_account":
    case "account_revoked":
    case "auth_failed":
      return reconnectGap(provider, repo);
    case "not_found":
      return unavailable(
        `o ${name} não acha o repositório ${repo} com a conexão do Studio (renomeado, apagado ou sem acesso)`,
        "customer",
      );
    case "provider_unconfigured":
      return unavailable(
        `o Studio não tem o ${name} configurado pra ler repositórios`,
      );
    default:
      return unavailable(`o Studio não lê o repositório ${repo} (${reason})`);
  }
}

/**
 * The gap of a failed read. `what` names the stage in unnamed failures
 * ("snapshot do repo", "tema do repo x").
 */
export function codeGapOf(
  err: unknown,
  what: string,
  repo: string,
  provider: RepoProvider = "github",
): SourceGap {
  if (err instanceof CodeGapError) return err.gap;
  if (err instanceof GitProviderError) {
    if (err.isRateLimited) {
      const wait =
        err.retryAfterMs !== null
          ? Math.max(1, Math.ceil(err.retryAfterMs / 1000))
          : null;
      return unavailable(
        `o ${PROVIDER_NAME[provider]} limitou as leituras do repositório ${repo}${wait ? ` (de novo em ${wait}s)` : ""}`,
        "external",
      );
    }
    if (err.isAuthFailure) return reconnectGap(provider, repo);
  }
  return {
    source: "github",
    error: `${what}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

export const repoLabel = (repo: RepoIdentity): string =>
  repo.host === "github.com" ? repo.path : `${repo.host}/${repo.path}`;

const SRC = "src/";

/** Each folder's direct children, built from the whole tree. */
function indexTree(tree: RepoTreeListing): {
  children: Map<string, RepoEntry[]>;
  files: Set<string>;
} {
  const children = new Map<string, RepoEntry[]>();
  const files = new Set<string>();
  const seen = new Set<string>();
  const add = (path: string, type: "file" | "dir", size: number) => {
    if (seen.has(path)) return;
    seen.add(path);
    const cut = path.lastIndexOf("/");
    const parent = cut < 0 ? "" : path.slice(0, cut);
    const list = children.get(parent) ?? [];
    list.push({ name: path.slice(cut + 1), path, type, size });
    children.set(parent, list);
  };
  for (const e of tree.entries) {
    const parts = e.path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      add(parts.slice(0, i).join("/"), "dir", 0);
    }
    if (e.type === "tree") add(parts.join("/"), "dir", 0);
    else {
      files.add(parts.join("/"));
      add(parts.join("/"), "file", e.size ?? 0);
    }
  }
  return { children, files };
}

/**
 * A view over `files`: the tree on the first read or listing (once), and each
 * file pinned to the tree's ref. A file over the ceiling is not read cut: it
 * is left out and goes to `skipped()`.
 */
export function openRepoView(
  files: Pick<RepoInsightsClient, "listTree" | "readFile">,
  label: string,
): CodeView {
  let indexed: Promise<{
    tree: RepoTreeListing;
    index: ReturnType<typeof indexTree>;
  }> | null = null;
  const tree = () => {
    indexed ??= files.listTree({ maxEntries: MAX_TREE_ENTRIES }).then((t) => ({
      tree: t,
      index: indexTree(t),
    }));
    return indexed;
  };
  const skipped = new Set<string>();

  const readFirst = async (candidates: string[]): Promise<string | null> => {
    const { tree: t, index } = await tree();
    // A whole tree: what is not in it does not exist, without spending a read.
    const tries = t.truncated
      ? candidates
      : candidates.filter((c) => index.files.has(c));
    for (const path of tries) {
      const file = await files.readFile({
        path,
        ref: t.ref,
        maxBytes: MAX_FILE_BYTES,
      });
      if (file.content === null) continue;
      if (file.truncated) {
        skipped.add(path);
        return null;
      }
      return file.content;
    }
    return null;
  };
  const childrenOf = async (dir: string): Promise<RepoEntry[]> => {
    const { index } = await tree();
    return index.children.get(dir.replace(/^\/+|\/+$/g, "")) ?? [];
  };

  return {
    repo: label,
    skipped: () => [...skipped],
    raw: {
      read: (path) => readFirst([path]),
      list: childrenOf,
    },
    read: (path) =>
      readFirst(path.startsWith(SRC) ? [path] : [path, `${SRC}${path}`]),
    async list(dir) {
      const clean = dir.replace(/^\/+|\/+$/g, "");
      const own = await childrenOf(clean);
      const inSrc = (await childrenOf(clean ? `${SRC}${clean}` : "src")).map(
        (e) => ({ ...e, path: e.path.slice(SRC.length) }),
      );
      const out = [...own];
      for (const e of inSrc) {
        if (!out.some((o) => o.path === e.path)) out.push(e);
      }
      return out;
    },
  };
}

/**
 * A reader that opens the view on the first file asked for (once). Without
 * access, none: the code test stays with the snapshot.
 */
export function lazyCodeReader(access: CodeAccess): RepoReader | undefined {
  if (access.kind !== "ready") return undefined;
  let view: Promise<CodeView> | null = null;
  return async (path) => {
    view ??= access.open();
    return (await view).read(path);
  };
}

/** The line naming the files the read ceiling left out. */
export function skippedFilesGap(paths: readonly string[]): SourceGap | null {
  if (paths.length === 0) return null;
  return {
    source: "github",
    error: `snapshot do repo: ${paths.length === 1 ? "1 arquivo ficou" : `${paths.length} arquivos ficaram`} de fora por passar de ${MAX_FILE_BYTES / 1000} KB (teto de leitura do Studio): ${paths.join(", ")}`,
  };
}
