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
} {
  const { org, locator } = useProjectContext();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.myCapabilities(locator),
    queryFn: async (): Promise<MyCapabilitiesResponse> => {
      const res = await fetch(
        `/api/auth/custom/my-capabilities/${encodeURIComponent(org.slug)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        return { role: null, capabilities: {} };
      }
      return (await res.json()) as MyCapabilitiesResponse;
    },
    staleTime: 30_000,
    retry: false,
  });

  return { data, loading: isLoading };
}

export interface CapabilityResult {
  granted: boolean;
  loading: boolean;
  reason: "loading" | "owner" | "admin" | "role" | "denied";
}

/**
 * Whether the current user has the given capability in the active org.
 */
export function useCapability(id: CapabilityId): CapabilityResult {
  const { data, loading } = useMyCapabilities();

  if (loading) {
    return { granted: false, loading: true, reason: "loading" };
  }

  const role = data?.role ?? null;
  if (!role) {
    return { granted: false, loading: false, reason: "denied" };
  }
  if (role === "owner") {
    return { granted: true, loading: false, reason: "owner" };
  }
  if (role === "admin") {
    return { granted: true, loading: false, reason: "admin" };
  }

  const granted = data?.capabilities?.[id] === true;
  return { granted, loading: false, reason: granted ? "role" : "denied" };
}

/**
 * The full capability bitmap plus role context, for screens that gate several
 * things at once. owner/admin already come back all-true from the server.
 */
export function useCapabilities(): {
  capabilities: Record<CapabilityId, boolean>;
  loading: boolean;
  isPrivileged: boolean;
  roleSlug: string | undefined;
} {
  const { data, loading } = useMyCapabilities();
  const role = data?.role ?? undefined;
  const isPrivileged = role ? BUILTIN_BYPASS_ROLES.has(role) : false;

  return {
    capabilities: (data?.capabilities ?? {}) as Record<CapabilityId, boolean>,
    loading,
    isPrivileged,
    roleSlug: role,
  };
}
