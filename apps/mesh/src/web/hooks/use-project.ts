/**
 * Project Hooks
 *
 * Provides React hooks for fetching project data using MCP tools.
 * Provides project information based on URL params.
 *
 * Projects are now stored as virtual MCPs with subtype = "project".
 * These hooks call COLLECTION_VIRTUAL_MCP_LIST to fetch project data
 * and map the VirtualMCPEntity shape back to the Project shape
 * expected by consumers.
 */

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMCPClient, SELF_MCP_ALIAS_ID } from "@decocms/mesh-sdk";
import { KEYS } from "../lib/query-keys";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";

/**
 * Project UI customization
 */
export interface ProjectUI {
  banner: string | null;
  bannerColor: string | null;
  icon: string | null;
  themeColor: string | null;
}

/**
 * Bound connection summary for display
 */
export interface BoundConnectionSummary {
  id: string;
  title: string;
  icon: string | null;
}

/**
 * Serialized project from API
 */
export interface Project {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  enabledPlugins: string[] | null;
  ui: ProjectUI | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project with bound connections (from list endpoint)
 */
export interface ProjectWithBindings extends Omit<Project, "organizationId"> {
  boundConnections: BoundConnectionSummary[];
}

type VirtualMCPListOutput = {
  items: VirtualMCPEntity[];
  totalCount: number;
  hasMore: boolean;
};

/**
 * Map a VirtualMCPEntity to the Project shape expected by consumers.
 */
function mapVirtualMCPToProject(
  entity: VirtualMCPEntity,
  organizationId: string,
): Project {
  const slug =
    (entity.metadata?.migrated_project_slug as string | undefined) ??
    ((entity.metadata?.ui as Record<string, unknown> | null | undefined)
      ?.slug as string | undefined) ??
    entity.id;

  return {
    id: entity.id,
    organizationId,
    slug,
    name: entity.title,
    description: entity.description,
    enabledPlugins:
      (entity.metadata?.enabled_plugins as string[] | null | undefined) ?? null,
    ui: entity.metadata?.ui
      ? {
          banner:
            ((entity.metadata.ui as Record<string, unknown>).banner as
              | string
              | null) ?? null,
          bannerColor:
            ((entity.metadata.ui as Record<string, unknown>).bannerColor as
              | string
              | null) ?? null,
          icon:
            ((entity.metadata.ui as Record<string, unknown>).icon as
              | string
              | null) ?? null,
          themeColor:
            ((entity.metadata.ui as Record<string, unknown>).themeColor as
              | string
              | null) ?? null,
        }
      : null,
    createdAt: entity.created_at,
    updatedAt: entity.updated_at,
  };
}

/**
 * Map a VirtualMCPEntity to the ProjectWithBindings shape.
 */
function mapVirtualMCPToProjectWithBindings(
  entity: VirtualMCPEntity,
): ProjectWithBindings {
  const slug =
    (entity.metadata?.migrated_project_slug as string | undefined) ??
    ((entity.metadata?.ui as Record<string, unknown> | null | undefined)
      ?.slug as string | undefined) ??
    entity.id;

  return {
    id: entity.id,
    slug,
    name: entity.title,
    description: entity.description,
    enabledPlugins:
      (entity.metadata?.enabled_plugins as string[] | null | undefined) ?? null,
    ui: entity.metadata?.ui
      ? {
          banner:
            ((entity.metadata.ui as Record<string, unknown>).banner as
              | string
              | null) ?? null,
          bannerColor:
            ((entity.metadata.ui as Record<string, unknown>).bannerColor as
              | string
              | null) ?? null,
          icon:
            ((entity.metadata.ui as Record<string, unknown>).icon as
              | string
              | null) ?? null,
          themeColor:
            ((entity.metadata.ui as Record<string, unknown>).themeColor as
              | string
              | null) ?? null,
        }
      : null,
    createdAt: entity.created_at,
    updatedAt: entity.updated_at,
    boundConnections: entity.connections.map((c) => ({
      id: c.connection_id,
      title: c.connection_id,
      icon: null,
    })),
  };
}

/**
 * Hook to fetch a project by organization ID and slug
 *
 * @param organizationId - Organization ID
 * @param slug - Project slug
 * @returns Query result with project data
 */
export function useProject(organizationId: string, slug: string) {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: organizationId,
  });

  return useQuery({
    queryKey: KEYS.project(organizationId, slug),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_LIST",
        arguments: {
          where: {
            field: ["subtype"],
            operator: "eq",
            value: "project",
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as VirtualMCPListOutput;

      // Find the project matching the slug
      const entity = payload.items.find((item) => {
        const itemSlug =
          (item.metadata?.migrated_project_slug as string | undefined) ??
          ((item.metadata?.ui as Record<string, unknown> | null | undefined)
            ?.slug as string | undefined) ??
          item.id;
        return itemSlug === slug;
      });

      if (!entity) {
        return null;
      }

      return mapVirtualMCPToProject(entity, organizationId);
    },
    enabled: !!organizationId && !!slug,
    staleTime: 30000, // 30 seconds
  });
}

/**
 * Hook to fetch all projects in an organization
 *
 * @param organizationId - Organization ID
 * @param options - Optional configuration
 * @param options.suspense - If true, uses useSuspenseQuery instead of useQuery
 * @returns Query result with projects array
 */
export function useProjects(
  organizationId: string,
  options?: { suspense?: boolean },
) {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: organizationId,
  });

  const queryConfig = {
    queryKey: KEYS.projects(organizationId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_LIST",
        arguments: {
          where: {
            field: ["subtype"],
            operator: "eq",
            value: "project",
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as VirtualMCPListOutput;
      // Map each virtual MCP entity to the ProjectWithBindings shape and add organizationId
      return payload.items.map((item) => ({
        ...mapVirtualMCPToProjectWithBindings(item),
        organizationId,
      })) as (ProjectWithBindings & { organizationId: string })[];
    },
    staleTime: 30000, // 30 seconds
  };

  if (options?.suspense) {
    return useSuspenseQuery(queryConfig);
  }

  return useQuery({
    ...queryConfig,
    enabled: !!organizationId,
  });
}
