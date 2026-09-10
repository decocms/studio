import type {
  VirtualMCPEntity,
  VirtualMcpSidebarView,
} from "@decocms/shared/sdk/types";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import {
  PROJECT_SIDEBAR_VIEWS_VERSION,
  type ProjectSidebarViewsMetadata,
} from "./project-sidebar-views";

interface OptimisticProjectSidebarViews {
  revision: number;
  views: VirtualMcpSidebarView[];
  rollbackViews: VirtualMcpSidebarView[];
}

export interface OptimisticProjectSidebarViewsSnapshot {
  revision: number;
  views: VirtualMcpSidebarView[];
  /** Last value confirmed by a completed request (or the persisted value from
   * before this optimistic edit began). */
  persistedViews: VirtualMcpSidebarView[];
}

export interface ProjectSidebarFormFields {
  sidebarViews: VirtualMcpSidebarView[] | null | undefined;
  sidebarViewsVersion: typeof PROJECT_SIDEBAR_VIEWS_VERSION | undefined;
}

interface SettleOptimisticProjectSidebarViewsOptions {
  snapshot: OptimisticProjectSidebarViewsSnapshot | null;
  saved: boolean;
  /** Value returned by the successful update, or read back after a failure.
   * `undefined` means no newer authoritative value could be obtained. */
  authoritativeViews?: readonly VirtualMcpSidebarView[];
}

interface OptimisticProjectSidebarViewsSettlement {
  /** Whether this result removed the latest overlay. Callers use this to avoid
   * replacing a newer form edit with an older server response. */
  settledLatest: boolean;
  /** When present, the form must adopt this server-confirmed value. An empty
   * list is valid, so callers must compare this with `null`. */
  reconciledViews: VirtualMcpSidebarView[] | null;
}

function cacheKey(orgId: string, virtualMcpId: string) {
  return KEYS.optimisticProjectSidebarViews(orgId, virtualMcpId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isVirtualMcpCollectionQueryKey(
  queryKey: readonly unknown[],
  orgId: string,
): boolean {
  return (
    queryKey[1] === orgId &&
    queryKey[3] === "collection" &&
    queryKey[4] === "VIRTUAL_MCP"
  );
}

function replaceCachedVirtualMcp(
  data: unknown,
  virtualMcp: VirtualMCPEntity,
): unknown {
  if (!isRecord(data)) return data;

  if ("item" in data && isRecord(data.item) && data.item.id === virtualMcp.id) {
    return { ...data, item: virtualMcp };
  }

  if (!("structuredContent" in data) || !isRecord(data.structuredContent)) {
    return data;
  }
  const items = data.structuredContent.items;
  if (!Array.isArray(items)) return data;

  let replaced = false;
  const nextItems = items.map((item) => {
    if (!isRecord(item) || item.id !== virtualMcp.id) return item;
    replaced = true;
    return virtualMcp;
  });
  return replaced
    ? {
        ...data,
        structuredContent: { ...data.structuredContent, items: nextItems },
      }
    : data;
}

/** Put a mutation response in both GET and LIST collection caches before the
 * optimistic overlay is removed. */
export function writeAuthoritativeVirtualMcpCaches(
  queryClient: QueryClient,
  orgId: string,
  virtualMcp: VirtualMCPEntity,
) {
  queryClient.setQueriesData(
    {
      predicate: (query) =>
        isVirtualMcpCollectionQueryKey(query.queryKey, orgId),
    },
    (data) => replaceCachedVirtualMcp(data, virtualMcp),
  );
}

/** Read the refetched item cache used by the settings form. */
export function readCachedVirtualMcp(
  queryClient: QueryClient,
  orgId: string,
  virtualMcpId: string,
): VirtualMCPEntity | null {
  const matches = queryClient.getQueriesData<{
    item?: VirtualMCPEntity | null;
  }>({
    predicate: (query) =>
      isVirtualMcpCollectionQueryKey(query.queryKey, orgId) &&
      query.queryKey[5] === virtualMcpId,
  });
  for (const [, data] of matches) {
    if (data?.item?.id === virtualMcpId) return data.item;
  }
  return null;
}

function readOverlay(
  queryClient: QueryClient,
  orgId: string,
  virtualMcpId: string,
): OptimisticProjectSidebarViews | null {
  return (
    queryClient.getQueryData<OptimisticProjectSidebarViews | null>(
      cacheKey(orgId, virtualMcpId),
    ) ?? null
  );
}

/** Seed a newly mounted form from an edit that outlived the previous Settings
 * panel; otherwise retain the server's raw versioned representation. */
export function initialProjectSidebarFormFields(
  metadata: ProjectSidebarViewsMetadata | null | undefined,
  pending: OptimisticProjectSidebarViewsSnapshot | null,
): ProjectSidebarFormFields {
  if (pending) {
    return {
      sidebarViews: [...pending.views],
      sidebarViewsVersion: PROJECT_SIDEBAR_VIEWS_VERSION,
    };
  }
  const sidebarViews = metadata?.sidebarViews;
  return {
    sidebarViews:
      sidebarViews === null
        ? null
        : sidebarViews
          ? [...sidebarViews]
          : undefined,
    sidebarViewsVersion: metadata?.sidebarViewsVersion,
  };
}

/** A remounted form can outlive the optimistic revision it was seeded from.
 * Before an unrelated full-record save, restore the latest cache-confirmed
 * pair so stale form defaults cannot overwrite a completed save or rollback. */
export function projectSidebarFormFieldsForSave(
  formFields: ProjectSidebarFormFields,
  pending: OptimisticProjectSidebarViewsSnapshot | null,
  authoritativeMetadata: ProjectSidebarViewsMetadata | null | undefined,
): ProjectSidebarFormFields {
  if (pending) {
    return {
      sidebarViews: [...pending.views],
      sidebarViewsVersion: PROJECT_SIDEBAR_VIEWS_VERSION,
    };
  }
  if (authoritativeMetadata === undefined) {
    return {
      sidebarViews:
        formFields.sidebarViews === null
          ? null
          : formFields.sidebarViews
            ? [...formFields.sidebarViews]
            : undefined,
      sidebarViewsVersion: formFields.sidebarViewsVersion,
    };
  }
  return initialProjectSidebarFormFields(authoritativeMetadata, null);
}

/** Stage an immediate client-only layout. Repeated clicks advance one revision
 * while retaining the last known persisted value for failure rollback. */
export function stageOptimisticProjectSidebarViews(
  queryClient: QueryClient,
  orgId: string,
  virtualMcpId: string,
  views: readonly VirtualMcpSidebarView[],
  rollbackViews: readonly VirtualMcpSidebarView[],
): OptimisticProjectSidebarViewsSnapshot {
  const current = readOverlay(queryClient, orgId, virtualMcpId);
  const next: OptimisticProjectSidebarViews = {
    revision: (current?.revision ?? 0) + 1,
    views: [...views],
    rollbackViews: current ? [...current.rollbackViews] : [...rollbackViews],
  };
  queryClient.setQueryData(cacheKey(orgId, virtualMcpId), next);
  return {
    revision: next.revision,
    views: [...next.views],
    persistedViews: [...next.rollbackViews],
  };
}

export function snapshotOptimisticProjectSidebarViews(
  queryClient: QueryClient,
  orgId: string,
  virtualMcpId: string,
): OptimisticProjectSidebarViewsSnapshot | null {
  const current = readOverlay(queryClient, orgId, virtualMcpId);
  return current
    ? {
        revision: current.revision,
        views: [...current.views],
        persistedViews: [...current.rollbackViews],
      }
    : null;
}

function sameViews(
  left: readonly VirtualMcpSidebarView[],
  right: readonly VirtualMcpSidebarView[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((view) => rightSet.has(view))
  );
}

/** RHF can report a clean form when a newer click returns to the value an
 * in-flight request used as its local baseline. The overlay's confirmed value
 * is the authority for deciding whether another write is still required. */
export function optimisticProjectSidebarViewsNeedSave(
  snapshot: OptimisticProjectSidebarViewsSnapshot | null,
): boolean {
  return snapshot ? !sameViews(snapshot.views, snapshot.persistedViews) : false;
}

/** Reconcile one serialized request without allowing an older response to
 * clear a newer click. Every authoritative response advances the rollback
 * point; only the latest revision removes the overlay. */
export function settleOptimisticProjectSidebarViews(
  queryClient: QueryClient,
  orgId: string,
  virtualMcpId: string,
  {
    snapshot,
    saved,
    authoritativeViews,
  }: SettleOptimisticProjectSidebarViewsOptions,
): OptimisticProjectSidebarViewsSettlement {
  if (!snapshot) {
    return { settledLatest: false, reconciledViews: null };
  }

  const current = readOverlay(queryClient, orgId, virtualMcpId);
  if (!current || snapshot.revision > current.revision) {
    return { settledLatest: false, reconciledViews: null };
  }

  const confirmedViews =
    authoritativeViews !== undefined
      ? [...authoritativeViews]
      : saved
        ? [...snapshot.views]
        : null;
  const next: OptimisticProjectSidebarViews = {
    ...current,
    rollbackViews: confirmedViews ?? current.rollbackViews,
  };
  if (next.rollbackViews !== current.rollbackViews) {
    queryClient.setQueryData(cacheKey(orgId, virtualMcpId), next);
  }

  if (snapshot.revision !== current.revision) {
    return { settledLatest: false, reconciledViews: null };
  }

  queryClient.setQueryData(cacheKey(orgId, virtualMcpId), null);
  const reconciledViews = saved
    ? confirmedViews && !sameViews(confirmedViews, snapshot.views)
      ? confirmedViews
      : null
    : [...next.rollbackViews];
  return { settledLatest: true, reconciledViews };
}

/** The sidebar's reactive overlay. `undefined` means there is no pending edit
 * and the persisted project metadata remains authoritative. */
export function useOptimisticProjectSidebarViews(
  virtualMcpId: string | null | undefined,
): readonly VirtualMcpSidebarView[] | undefined {
  const { org } = useProjectContext();
  const { data } = useQuery<OptimisticProjectSidebarViews | null>({
    queryKey: cacheKey(org.id, virtualMcpId ?? ""),
    queryFn: async () => null,
    // This key is an in-memory overlay, not fetched state. A disabled observer
    // still reacts to `setQueryData` without a queryFn racing a staged value.
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data?.views;
}

export function useOptimisticProjectSidebarViewsActions(virtualMcpId: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  return {
    stage: (
      views: readonly VirtualMcpSidebarView[],
      rollbackViews: readonly VirtualMcpSidebarView[],
    ) =>
      stageOptimisticProjectSidebarViews(
        queryClient,
        org.id,
        virtualMcpId,
        views,
        rollbackViews,
      ),
    snapshot: () =>
      snapshotOptimisticProjectSidebarViews(queryClient, org.id, virtualMcpId),
    settle: (options: SettleOptimisticProjectSidebarViewsOptions) =>
      settleOptimisticProjectSidebarViews(
        queryClient,
        org.id,
        virtualMcpId,
        options,
      ),
  };
}
