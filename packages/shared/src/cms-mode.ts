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

/** The editing mode a draft is in. Persisted in the URL as `?mode=`. */
export type CmsEditingMode = "cms" | "vibecoding";

/**
 * Whether a *branch* is being served the CMS way right now — decofile over
 * HTTP against the preview server, rather than through a pod.
 *
 * Two inputs, and they are not the same question. `hasSandbox` says what the
 * branch HAS; `mode` says which way the user is currently editing it. A branch
 * with no sandbox has no choice and is always CMS. A branch WITH one follows
 * the mode, so switching back to CMS restores the whole CMS workspace —
 * preview origin, tabs, console — and not just the side panel.
 *
 * The cost of honouring the mode over the substrate: a CMS write then commits
 * to the branch head while the pod still holds an uncommitted working tree it
 * cannot see. That divergence is real and deliberate — surfaced to the user by
 * the staleness advisory rather than prevented — so anything reading this to
 * decide where a WRITE lands must also be prepared to say so.
 */
export function resolveCmsModeForBranch(
  metadata: CmsModeMetadata | null | undefined,
  hasSandbox: boolean,
  mode: CmsEditingMode = "cms",
): CmsModeGate {
  const gate = resolveCmsMode(metadata);
  const cmsSelected = !hasSandbox || mode === "cms";
  return { ...gate, active: gate.active && cmsSelected };
}
