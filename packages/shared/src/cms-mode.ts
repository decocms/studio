/**
 * The CMS-mode gate, in ONE place — shared by the web app and the API.
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
