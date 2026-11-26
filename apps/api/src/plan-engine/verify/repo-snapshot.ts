/**
 * The store's code for the code tests: read from the sections the page uses,
 * kept in the org's object storage, and pointed at from the evidence. Read in
 * the run's `repo-snapshot` step and again when "verify again" starts.
 */

import { MEDIA_UNAVAILABLE } from "../adapters/unavailable.ts";
import type { MediaStore } from "../ports.ts";
import type { DiagnosisEvidence, SourceGap } from "../types.ts";
import {
  type CodeAccess,
  type CodeView,
  codeGapOf,
  skippedFilesGap,
} from "./code-source.ts";
import { storeRepoSnapshot } from "./repo.ts";

/** The evidence with the gap, without repeating one collect already wrote. */
export function withGap(
  evidence: DiagnosisEvidence,
  gap: SourceGap,
): DiagnosisEvidence {
  return evidence.gaps.some(
    (g) => g.source === gap.source && g.error === gap.error,
  )
    ? evidence
    : { ...evidence, gaps: [...evidence.gaps, gap] };
}

const pageOf = (evidence: DiagnosisEvidence) => ({
  type: evidence.page_type ?? "pdp",
  route: evidence.page_route ?? null,
});

/**
 * Reads the repo from the sections the page uses and points the evidence at
 * the snapshot. A failure becomes the owned gap and never stops verification;
 * files over the read ceiling become a gap line naming them.
 */
export async function withRepoSnapshot(opts: {
  evidence: DiagnosisEvidence;
  access: CodeAccess;
  media: MediaStore | null;
  key: string;
}): Promise<DiagnosisEvidence> {
  const { evidence, access } = opts;
  if (access.kind === "gap") return withGap(evidence, access.gap);
  let view: CodeView | null = null;
  const skipped = (e: DiagnosisEvidence) => {
    const gap = skippedFilesGap(view?.skipped() ?? []);
    return gap ? withGap(e, gap) : e;
  };
  try {
    if (!opts.media) throw new Error(MEDIA_UNAVAILABLE);
    view = await access.open();
    const key = await storeRepoSnapshot({
      media: opts.media,
      key: opts.key,
      read: view.read,
      list: view.list,
      repo: view.repo,
      pdp: evidence.pdp_behaviour,
      page: pageOf(evidence),
    });
    return skipped({ ...evidence, repo_snapshot_key: key });
  } catch (err) {
    return skipped(
      withGap(
        evidence,
        codeGapOf(err, "snapshot do repo", access.repo, access.provider),
      ),
    );
  }
}

/** Ceiling on the re-read inside a tool call (the MCP host cuts at about 60 s). */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Reads the repo again for "verify again", under the same key: the round's
 * snapshot is replaced. Resolves to the evidence to write (null = keep it)
 * and the line for the tool's answer; failing never blocks verification.
 */
export async function refreshRepoSnapshot(opts: {
  evidence: DiagnosisEvidence;
  access: CodeAccess;
  media: MediaStore | null;
  key: string;
}): Promise<{ evidence: DiagnosisEvidence | null; note: string }> {
  const { evidence, access } = opts;
  const fallback = evidence.repo_snapshot_key
    ? "vale o snapshot da rodada"
    : "os testes de código saem 'não deu pra testar'";
  if (access.kind === "gap") {
    return { evidence: null, note: `${access.gap.error}: ${fallback}` };
  }
  const media = opts.media;
  if (!media) {
    return { evidence: null, note: `${MEDIA_UNAVAILABLE}: ${fallback}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { key, skipped } = await Promise.race([
      access.open().then(async (view) => ({
        key: await storeRepoSnapshot({
          media,
          key: opts.key,
          read: view.read,
          list: view.list,
          repo: view.repo,
          pdp: evidence.pdp_behaviour,
          page: pageOf(evidence),
        }),
        skipped: skippedFilesGap(view.skipped()),
      })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`passou de ${REFRESH_TIMEOUT_MS / 1000}s lendo o repo`),
            ),
          REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      evidence: { ...evidence, repo_snapshot_key: key },
      note: `snapshot do repo refeito (${access.repo})${skipped ? `; ${skipped.error}` : ""}`,
    };
  } catch (err) {
    const gap = codeGapOf(
      err,
      "não deu pra refazer o snapshot do repo",
      access.repo,
      access.provider,
    );
    return { evidence: null, note: `${gap.error}: ${fallback}` };
  } finally {
    clearTimeout(timer);
  }
}
