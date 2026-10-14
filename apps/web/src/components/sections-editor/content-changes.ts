/**
 * A v8 project's changes, over the content protocol (1.1): which entries
 * differ from the source's base (`changes.list`), both sides of them
 * (`changes.get`), and dropping them back to the base (`changes.discard`).
 * Every v8 source answers them the same way: Studio's GitHub backend (main
 * plus the CDN draft), a sandbox's working tree (against its last commit) and
 * a `deco serve` (against the site's last commit), so the publish dialog,
 * the header's count and the Localhost changes list share this one path.
 *
 * The list is polled with the content (content-protocol-api.ts adds
 * `changes.list` to the poll's batch, conditional on its revision), so it
 * follows edits made elsewhere with no extra request; every content change
 * re-reads it (content-sync.ts).
 */

import {
  type QueryClient,
  skipToken,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type BlocksApplyResult,
  type Change,
  type ChangeDetail,
  type ChangeDiagnostic,
  type ChangesBase,
  type ChangesListResult,
  type ContentClient,
  ContentProtocolError,
  ErrorCode,
  type UnsupportedEndpointData,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend, ProtocolBackend } from "./content-backend";

/** The changes of a source against its base, as last listed. */
export interface ContentChanges {
  /** The changes' own revision (`ifNoneMatch` for the next poll). */
  revision: string;
  base: ChangesBase;
  /** Every entry that differs from the base, by name. */
  changes: Record<string, Change>;
}

/** Both sides of the listed changes, by entry name. */
export interface ContentChangeSides {
  entries: Record<string, ChangeDetail>;
  diagnostics: ChangeDiagnostic[];
}

/** Names per `changes.get` (the protocol's limit). */
export const CHANGES_GET_NAMES = 20;
/** `changes.get` calls sent in one batched request. */
const CHANGES_GET_CALLS_PER_REQUEST = 5;
/** Names per `changes.discard` (the protocol's limit). */
export const CHANGES_DISCARD_NAMES = 500;

/**
 * Whether an error says the server is older than this Studio: Unsupported
 * with `reason: "outdated"` (an endpoint on protocol 1.0), or MethodNotFound
 * on a `changes.*` call (the client turns that into the former; kept for any
 * other caller).
 */
export function isOutdatedServerError(error: unknown): boolean {
  if (!(error instanceof ContentProtocolError)) return false;
  if (error.code === ErrorCode.MethodNotFound) return true;
  return (
    error.code === ErrorCode.Unsupported &&
    (error.data as Partial<UnsupportedEndpointData> | undefined)?.reason ===
      "outdated"
  );
}

/** A `changes.list` answer folded into what was listed before. */
export function adoptChangesList(
  previous: ContentChanges | undefined,
  result: ChangesListResult,
): ContentChanges | null {
  if (!result.notModified) {
    return {
      revision: result.revision,
      base: result.base,
      changes: result.changes,
    };
  }
  return previous ? { ...previous, base: result.base } : null;
}

/** One `changes.list`, conditional on what the cache holds. */
export async function readContentChanges(
  queryClient: QueryClient,
  client: ContentClient,
  cacheKey: string,
): Promise<ContentChanges> {
  const key = KEYS.contentChanges(cacheKey);
  const seen = queryClient.getQueryData<ContentChanges>(key);
  const answer = await client.changesList(
    seen ? { ifNoneMatch: seen.revision } : {},
  );
  const adopted = adoptChangesList(seen, answer);
  if (adopted) return adopted;
  // A revision without its list (the cache was dropped): read it whole.
  const whole = await client.changesList({});
  return adoptChangesList(undefined, whole)!;
}

/** Both sides of `names`, 20 per call, a few calls per request. */
export async function readChangeSides(
  client: ContentClient,
  names: readonly string[],
): Promise<ContentChangeSides> {
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += CHANGES_GET_NAMES) {
    chunks.push(names.slice(i, i + CHANGES_GET_NAMES));
  }
  const entries: Record<string, ChangeDetail> = Object.create(null);
  const diagnostics: ChangeDiagnostic[] = [];
  for (let i = 0; i < chunks.length; i += CHANGES_GET_CALLS_PER_REQUEST) {
    const outcomes = await client.batch(
      chunks
        .slice(i, i + CHANGES_GET_CALLS_PER_REQUEST)
        .map((chunk) => ({ method: "changes.get", params: { names: chunk } })),
    );
    for (const outcome of outcomes) {
      if (!outcome.ok) throw outcome.error;
      const result = outcome.result as {
        entries: Record<string, ChangeDetail>;
        diagnostics: ChangeDiagnostic[];
      };
      Object.assign(entries, result.entries);
      diagnostics.push(...result.diagnostics);
    }
  }
  return { entries, diagnostics };
}

/**
 * Drops entries back to the base: one `changes.discard` per 500 names, each
 * guarded by the version the list showed (`ifMatch`), so a change made after
 * the user looked is never dropped (a Conflict instead).
 */
export async function discardContentChanges(
  client: ContentClient,
  entries: ReadonlyArray<{ name: string; version: string | null }>,
): Promise<BlocksApplyResult> {
  let result: BlocksApplyResult = { revision: "", versions: {} };
  for (let i = 0; i < entries.length; i += CHANGES_DISCARD_NAMES) {
    const chunk = entries.slice(i, i + CHANGES_DISCARD_NAMES);
    const answer = await client.changesDiscard({
      names: chunk.map((entry) => entry.name),
      ifMatch: Object.fromEntries(
        chunk.map((entry) => [entry.name, entry.version]),
      ),
    });
    result = {
      revision: answer.revision,
      versions: { ...result.versions, ...answer.versions },
    };
  }
  return result;
}

/** Whether a discard failed because an entry changed after it was listed. */
export function isChangedMeanwhile(error: unknown): boolean {
  return (
    error instanceof ContentProtocolError && error.code === ErrorCode.Conflict
  );
}

function protocolOf(backend: ContentBackend | null): ProtocolBackend | null {
  return backend?.kind === "protocol" ? backend : null;
}

/**
 * The changes of a protocol backend (`cacheKey`: the editor's decofile cache
 * key). Disabled for any other backend. Re-read on mount, so a surface that
 * opens shows the current list; between mounts the poll keeps it current.
 */
export function useContentChanges(
  backend: ContentBackend | null,
  cacheKey: string | null,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const protocol = protocolOf(backend);
  const enabled = !!protocol && !!cacheKey && options.enabled !== false;
  return useQuery({
    queryKey: KEYS.contentChanges(cacheKey ?? ""),
    queryFn: enabled
      ? () => readContentChanges(queryClient, protocol!.client, cacheKey!)
      : skipToken,
    staleTime: 0,
  });
}

/**
 * Both sides of every listed change, read once per changes revision (a new
 * revision is a new entry). Never needed to show the list: it only adds what
 * changed inside each entry and the before/after code.
 */
export function useContentChangeSides(
  backend: ContentBackend | null,
  cacheKey: string | null,
  changes: ContentChanges | undefined,
) {
  const protocol = protocolOf(backend);
  const names = changes ? Object.keys(changes.changes) : [];
  const enabled = !!protocol && !!cacheKey && !!changes && names.length > 0;
  return useQuery({
    queryKey: KEYS.contentChangeSides(cacheKey ?? "", changes?.revision ?? ""),
    queryFn: enabled
      ? () => readChangeSides(protocol!.client, names)
      : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
