/**
 * Tags Hooks
 *
 * Provides React hooks for managing organization tags and member tag assignments.
 * Calls builtin tools over REST via the typed studio-tools client.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { toast } from "sonner";
import { KEYS } from "../lib/query-keys";
import { useStudioTools } from "../lib/studio-tools";

/**
 * Tag data structure
 */
export interface Tag {
  id: string;
  organizationId: string;
  name: string;
  createdAt: string;
}

/**
 * Hook to fetch all organization tags
 */
export function useTags() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.tags(locator),
    queryFn: async () => {
      const { tags } = await studio.call("TAGS_LIST", {});
      return tags;
    },
    staleTime: 30000, // 30 seconds
  });
}

/**
 * Hook to create a new tag
 */
export function useCreateTag() {
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useMutation({
    mutationFn: async (name: string) => {
      const { tag } = await studio.call("TAGS_CREATE", { name });
      return tag;
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

/**
 * Hook to fetch tags for a specific member
 */
export function useMemberTags(memberId: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.memberTags(locator, memberId),
    queryFn: async () => {
      const { tags } = await studio.call("MEMBER_TAGS_GET", { memberId });
      return tags;
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
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useMutation({
    mutationFn: async ({
      memberId,
      tagIds,
    }: {
      memberId: string;
      tagIds: string[];
    }) => {
      return await studio.call("MEMBER_TAGS_SET", { memberId, tagIds });
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
