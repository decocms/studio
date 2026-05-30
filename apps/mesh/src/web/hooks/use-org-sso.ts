import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import type { OrgSsoConfigPublic } from "../../storage/types";

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

export function useOrgSsoStatus(
  orgId: string | undefined,
  orgSlug: string | undefined,
) {
  return useQuery({
    queryKey: KEYS.orgSsoStatus(orgId ?? ""),
    queryFn: async (): Promise<SsoStatusResponse> => {
      const response = await fetch(`/api/${orgSlug}/sso/status`);
      if (!response.ok) throw new Error("Failed to check SSO status");
      return response.json();
    },
    enabled: !!orgId && !!orgSlug,
  });
}

export function useOrgSsoConfig(
  orgId: string | undefined,
  orgSlug: string | undefined,
) {
  return useQuery({
    queryKey: KEYS.orgSsoConfig(orgId ?? ""),
    queryFn: async (): Promise<SsoConfigResponse> => {
      const response = await fetch(`/api/${orgSlug}/sso/config`);
      if (!response.ok) throw new Error("Failed to fetch SSO config");
      return response.json();
    },
    enabled: !!orgId && !!orgSlug,
  });
}

export function useSaveOrgSsoConfig(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string;
      scopes?: string[];
      domain: string;
      enforced?: boolean;
    }) => {
      const response = await fetch(`/api/${orgSlug}/sso/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save SSO config");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}

export function useDeleteOrgSsoConfig(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/${orgSlug}/sso/config`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete SSO config");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}

export function useToggleSsoEnforcement(orgId: string, orgSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (enforced: boolean) => {
      const response = await fetch(`/api/${orgSlug}/sso/config/enforce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enforced }),
      });
      if (!response.ok) throw new Error("Failed to toggle SSO enforcement");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoConfig(orgId) });
      queryClient.invalidateQueries({ queryKey: KEYS.orgSsoStatus(orgId) });
    },
  });
}
