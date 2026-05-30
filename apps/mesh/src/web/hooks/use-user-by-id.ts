/**
 * User Hook using React Query
 *
 * Provides a React hook for fetching user data from the API.
 * Users can only fetch data for users in their shared organizations.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";

/**
 * User data returned by the API
 */
export interface UserData {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

type UserGetOutput = { user: UserData | null };

/**
 * Hook for fetching user data
 *
 * @param userId - The user ID to fetch
 * @returns React Query result with user data
 */
export function useUserById(userId: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.user(userId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "USER_GET",
        arguments: { id: userId },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as UserGetOutput;
      return payload.user;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - users don't change frequently
    retry: 1,
    enabled: !!userId,
  });
}
