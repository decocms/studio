/**
 * Tags Hooks
 *
 * Provides React hooks for managing organization tags and member tag assignments.
 * Uses MCP tools for all operations.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { KEYS } from "../lib/query-keys";

/**
 * Tag data structure
 */
export interface Tag {
  id: string;
  organizationId: string;
  name: string;
  createdAt: string;
}

type TagsListOutput = { tags: Tag[] };
type TagCreateOutput = { tag: Tag };

/**
 * Hook to fetch all organization tags
 */
export function useTags() {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.tags(locator),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TAGS_LIST",
        arguments: {},
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as TagsListOutput;
      return payload.tags;
    },
    staleTime: 30000, // 30 seconds
  });
}

/**
 * Hook to create a new tag
 */
export function useCreateTag() {
  const queryClient = useQueryClient();
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (name: string) => {
      const result = (await client.callTool({
        name: "TAGS_CREATE",
        arguments: { name },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as TagCreateOutput;
      return payload.tag;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.tags(locator) });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to create tag",
      );
    },
  });
}

// ============================================================================
// Member Tags Hooks
// ============================================================================

type MemberTagsGetOutput = { tags: Tag[] };
type MemberTagsSetOutput = { success: boolean; tags: Tag[] };

/**
 * Hook to fetch tags for a specific member
 */
export function useMemberTags(memberId: string) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.memberTags(locator, memberId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "MEMBER_TAGS_GET",
        arguments: { memberId },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as MemberTagsGetOutput;
      return payload.tags;
    },
    staleTime: 30000, // 30 seconds
    enabled: !!memberId,
  });
}

/**
 * Hook to set tags for a member
 */
export function useSetMemberTags() {
  const queryClient = useQueryClient();
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async ({
      memberId,
      tagIds,
    }: {
      memberId: string;
      tagIds: string[];
    }) => {
      const result = (await client.callTool({
        name: "MEMBER_TAGS_SET",
        arguments: { memberId, tagIds },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as MemberTagsSetOutput;
      return payload;
    },
    onSuccess: (_data, variables) => {
      // Invalidate the specific member's tags
      queryClient.invalidateQueries({
        queryKey: KEYS.memberTags(locator, variables.memberId),
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to update member tags",
      );
    },
  });
}
