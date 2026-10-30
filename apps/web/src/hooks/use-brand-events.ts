/**
 * useBrandLiveSync — a brand's pages, current while its files are written.
 *
 * Subscribes to the shared `/api/:org/watch` connection, filtered to
 * `brand.updated`. Every write under `home/brands/<brand>/` pushes one, the
 * agent's writes through the sandbox mount included, so the brand page and
 * the content track follow a guide being filled without a reload.
 *
 * Mirrors `useBlogCardEvents`.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useSyncExternalStore } from "react";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { invalidateOrgFsWrite, orgFsReadUrl } from "./use-org-fs";
import { brandWatchView } from "./watch-sse-pool";

const getSnapshot = () => 0;

/** Whether a text query reads a file of this brand, or of any brand. */
export function readsBrandFile(
  queryKey: readonly unknown[],
  orgSlug: string,
  brand?: string,
): boolean {
  const url = queryKey[1];
  const folder = brand ? `brands/${brand}/` : "brands/";
  return (
    queryKey[0] === "file-text" &&
    typeof url === "string" &&
    url.startsWith(orgFsReadUrl(orgSlug, HOME_MOUNT_PATH, folder))
  );
}

interface UseBrandEventsOptions {
  orgSlug: string;
  onUpdate: (brand: string) => void;
  /** Called after each stream re-establishment — refetch to close the gap. */
  onResync: () => void;
}

function useBrandEvents(options: UseBrandEventsOptions): void {
  const { orgSlug, onUpdate, onResync } = options;

  const onUpdateRef = useRef(onUpdate);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onUpdateRef.current = onUpdate;

  const onResyncRef = useRef(onResync);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onResyncRef.current = onResync;

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevOrgSlug = useRef(orgSlug);

  const needsRebuild =
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    !subscribeRef.current ||
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevOrgSlug.current !== orgSlug;

  if (needsRebuild) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevOrgSlug.current = orgSlug;

    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    subscribeRef.current = (onStoreChange: () => void) => {
      if (!orgSlug) return () => {};

      const handler = (e: MessageEvent) => {
        let brand: unknown;
        try {
          brand = (JSON.parse(e.data) as { data?: { brand?: unknown } }).data
            ?.brand;
        } catch {
          return;
        }
        if (typeof brand === "string" && brand) onUpdateRef.current(brand);
        onStoreChange();
      };

      return brandWatchView.subscribe(orgSlug, handler, () =>
        onResyncRef.current(),
      );
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);
}

/** Refreshes what a brand's page reads when that brand's files change. */
export function useBrandLiveSync(): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  const refresh = (brand?: string) => {
    invalidateOrgFsWrite(queryClient, org.id, HOME_MOUNT_PATH);
    void queryClient.invalidateQueries({ queryKey: KEYS.blogState(org.slug) });
    void queryClient.invalidateQueries({
      predicate: (query) => readsBrandFile(query.queryKey, org.slug, brand),
    });
  };

  useBrandEvents({
    orgSlug: org.slug,
    onUpdate: refresh,
    onResync: () => refresh(),
  });
}
