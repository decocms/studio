/**
 * User Hook using React Query
 *
 * Provides a React hook for fetching user data from the API.
 * Users can only fetch data for users in their shared organizations.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * User data returned by the API
 */
export interface UserData {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/**
 * Hook for fetching user data
 *
 * @param userId - The user ID to fetch
 * @returns React Query result with user data
 */
export function useUserById(userId: string) {
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.user(userId),
    queryFn: async () => {
      const { user } = await studio.call("USER_GET", { id: userId });
      return user;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - users don't change frequently
    retry: 1,
    enabled: !!userId,
  });
}
