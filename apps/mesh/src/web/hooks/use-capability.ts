/**
 * useCapability / useCapabilities
 *
 * Resolve whether the current user has a given permission capability in the
 * active org, for proactive UI gating (hide / disable / redirect) so users
 * don't see actions that would fail at the API.
 *
 * Backed by GET /api/auth/custom/my-capabilities/:slug — the server is the
 * single source of truth. This hook only reads the resolved bitmap; it never
 * re-derives role logic.
 */

import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export type CapabilityId =
  | "org:manage"
  | "members:manage"
  | "connections:manage"
  | "agents:manage"
  | "automations:manage"
  | "monitoring:view"
  | "secrets:manage"
  | "file-configs:manage"
  | "ai-providers:manage"
  | "tags:manage"
  | "registry:manage"
  | "registry:monitor"
  | "api-keys:manage"
  | "event-bus:use"
  | "storage:delete"
  | "connections:sql";

const BUILTIN_BYPASS_ROLES = new Set(["owner", "admin"]);

interface MyCapabilitiesResponse {
  role: string | null;
  capabilities: Record<string, boolean>;
}

function useMyCapabilities(): {
  data: MyCapabilitiesResponse | undefined;
  loading: boolean;
  error: boolean;
} {
  const { org, locator } = useProjectContext();

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.myCapabilities(locator),
    queryFn: async (): Promise<MyCapabilitiesResponse> => {
      const res = await fetch(
        `/api/auth/custom/my-capabilities/${encodeURIComponent(org.slug)}`,
        { credentials: "include" },
      );
      // Throw on failure so it surfaces as an error state — NOT a silent
      // "denied". Swallowing it would make a transient blip lock owners and
      // admins out of every gated route, indistinguishable from real denial.
      if (!res.ok) {
        throw new Error(`my-capabilities request failed: ${res.status}`);
      }
      return (await res.json()) as MyCapabilitiesResponse;
    },
    staleTime: 30_000,
    // Ride out transient failures before surfacing an error to the UI.
    retry: 2,
  });

  return { data, loading: isLoading, error: isError };
}

export interface CapabilityResult {
  granted: boolean;
  loading: boolean;
  /** True when capabilities couldn't be resolved (network/server error). */
  error: boolean;
  reason: "loading" | "error" | "owner" | "admin" | "role" | "denied";
}

/**
 * Whether the current user has the given capability in the active org.
 */
export function useCapability(id: CapabilityId): CapabilityResult {
  const { data, loading, error } = useMyCapabilities();

  if (loading) {
    return { granted: false, loading: true, error: false, reason: "loading" };
  }
  if (error) {
    return { granted: false, loading: false, error: true, reason: "error" };
  }

  const role = data?.role ?? null;
  if (!role) {
    return { granted: false, loading: false, error: false, reason: "denied" };
  }
  if (role === "owner") {
    return { granted: true, loading: false, error: false, reason: "owner" };
  }
  if (role === "admin") {
    return { granted: true, loading: false, error: false, reason: "admin" };
  }

  const granted = data?.capabilities?.[id] === true;
  return {
    granted,
    loading: false,
    error: false,
    reason: granted ? "role" : "denied",
  };
}

/**
 * The full capability bitmap plus role context, for screens that gate several
 * things at once. owner/admin already come back all-true from the server.
 */
export function useCapabilities(): {
  capabilities: Record<CapabilityId, boolean>;
  loading: boolean;
  error: boolean;
  isPrivileged: boolean;
  roleSlug: string | undefined;
} {
  const { data, loading, error } = useMyCapabilities();
  const role = data?.role ?? undefined;
  const isPrivileged = role ? BUILTIN_BYPASS_ROLES.has(role) : false;

  return {
    capabilities: (data?.capabilities ?? {}) as Record<CapabilityId, boolean>,
    loading,
    error,
    isPrivileged,
    roleSlug: role,
  };
}
