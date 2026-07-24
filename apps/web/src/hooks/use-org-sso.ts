import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import type { OrgSsoConfigPublic } from "@decocms/shared/entities";

interface SsoStatusResponse {
  ssoRequired: boolean;
  authenticated?: boolean;
  issuer?: string;
  domain?: string;
}

interface SsoConfigResponse {
  configured: boolean;
  config?: OrgSsoConfigPublic;
}

/** Fetch + parse JSON, throwing `errorMessage` (or the body's own `error`) on failure. */
async function ssoFetch<T>(
  url: string,
  init: RequestInit | undefined,
  errorMessage: string,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || errorMessage);
  }
  return response.json();
}

export function useOrgSsoStatus(
  orgId: string | undefined,
  orgSlug: string | undefined,
) {
  return useQuery({
    queryKey: KEYS.orgSsoStatus(orgId ?? ""),
    queryFn: () =>
      ssoFetch<SsoStatusResponse>(
        `/api/${orgSlug}/sso/status`,
        undefined,
        "Failed to check SSO status",
      ),
    enabled: !!orgId && !!orgSlug,
  });
}

export function useOrgSsoConfig(
  orgId: string | undefined,
  orgSlug: string | undefined,
) {
  return useQuery({
    queryKey: KEYS.orgSsoConfig(orgId ?? ""),
    queryFn: () =>
      ssoFetch<SsoConfigResponse>(
        `/api/${orgSlug}/sso/config`,
        undefined,
        "Failed to fetch SSO config",
      ),
    enabled: !!orgId && !!orgSlug,
  });
}

export function useSaveOrgSsoConfig(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string;
      scopes?: string[];
      domain: string;
      enforced?: boolean;
    }) =>
      ssoFetch(
        `/api/${orgSlug}/sso/config`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
        "Failed to save SSO config",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}

export function useDeleteOrgSsoConfig(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      ssoFetch(
        `/api/${orgSlug}/sso/config`,
        { method: "DELETE" },
        "Failed to delete SSO config",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}

export function useToggleSsoEnforcement(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enforced: boolean) =>
      ssoFetch(
        `/api/${orgSlug}/sso/config/enforce`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enforced }),
        },
        "Failed to toggle SSO enforcement",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}
