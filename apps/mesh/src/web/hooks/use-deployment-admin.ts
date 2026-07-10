/**
 * useDeploymentAdmin
 *
 * Whether the current user is an allowlisted deployment admin — gates the
 * "Admin Dashboard" entry and the /_admin routes. No org context (instance
 * level), unlike useCapability. Backed by GET /api/_admin/me: the middleware
 * IS the check, so 200 means yes and 401/403 means no.
 *
 * The answer is constant for the life of the page (it depends only on env
 * config + session), so `staleTime: Infinity` — one probe per load, no
 * refetch-on-focus. A 5xx is thrown (not read as "denied") so react-query
 * retries a transient blip instead of flipping an admin to "Not authorized".
 */
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export function useDeploymentAdmin(): { isAdmin: boolean; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: KEYS.deploymentAdminMe(),
    queryFn: async () => {
      const res = await fetch("/api/_admin/me", { credentials: "include" });
      if (res.status >= 500) {
        throw new Error(`admin/me request failed: ${res.status}`);
      }
      return res.ok;
    },
    staleTime: Infinity,
    retry: 2,
  });

  return { isAdmin: data === true, loading: isLoading };
}
