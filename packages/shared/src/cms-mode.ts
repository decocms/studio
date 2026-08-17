/**
 * The CMS-mode gate, in ONE place — shared by the web app and the API.
 *
 * `resolveCmsMode` is the project capability; `resolveCmsModeForBranch` narrows
 * it to a single branch, and runtime surfaces gate on the latter.
 *
 * CMS mode (formerly "Fast Preview") is the sandbox-less editing surface: the
 * decofile is read and written over HTTP against a preview server instead of
 * through the sandbox daemon, so no pod is needed. That is only possible when a
 * preview server URL is persisted, which is why the URL is part of the gate
 * rather than a separate check — a bare flag with no URL has nothing to render
 * against.
 *
 * `metadata.cmsMode` is the current key; `metadata.fastPreview` is the legacy
 * one and is still read. Writers keep writing `fastPreview` until every reader
 * ships — the API gates the decofile route on it (`decofile.ts`) and the
 * sandbox proxy mints its sandbox-less claim from it, so a premature switch
 * would 404 the CMS for any project toggled after the change.
 */

import { resolvePreviewServerUrl } from "./deco-site-production-url.ts";

export interface CmsModeMetadata {
  previewServerUrl?: string | null;
  productionUrl?: string | null;
  cmsMode?: boolean | null;
  /** Legacy key for {@link CmsModeMetadata.cmsMode}. */
  fastPreview?: boolean | null;
}

export interface CmsModeGate {
  previewServerUrl: string | null;
  active: boolean;
}

/**
 * Whether a *branch* is being served sandbox-lessly right now.
 *
 * `resolveCmsMode` answers a question about the PROJECT ("can this edit content
 * without a pod?"); this answers the one every runtime surface actually needs
 * ("is there a pod serving this branch?"). They differ the moment a sandbox is
 * provisioned: a CMS project keeps its flag, but that branch now has a working
 * tree, a dev server and a daemon, and every read/write must go through them.
 *
 * Routing on the project flag instead would give the branch two writers — the
 * CMS committing to the branch head while the pod edits an uncommitted working
 * tree it can no longer see. Routing on this keeps exactly one writer per
 * branch, whichever layer that branch currently lives in, so the two editing
 * surfaces compose instead of diverging.
 *
 * `hasSandbox` is the branch's recorded sandbox (`sandboxMap[user][branch]`),
 * not a liveness probe: a stopped or evicted pod is still that branch's home
 * and resumes rather than handing the branch back to the head-committing path.
 */
export function resolveCmsModeForBranch(
  metadata: CmsModeMetadata | null | undefined,
  hasSandbox: boolean,
): CmsModeGate {
  const gate = resolveCmsMode(metadata);
  return { ...gate, active: gate.active && !hasSandbox };
}

/** True when either the current or the legacy flag is set. */
function readCmsModeFlag(
  metadata: CmsModeMetadata | null | undefined,
): boolean {
  return metadata?.cmsMode === true || metadata?.fastPreview === true;
}

export function resolveCmsMode(
  metadata: CmsModeMetadata | null | undefined,
): CmsModeGate {
  const previewServerUrl = resolvePreviewServerUrl(metadata);
  return {
    previewServerUrl,
    active: !!previewServerUrl && readCmsModeFlag(metadata),
  };
}
