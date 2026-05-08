import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { track } from "@/web/lib/posthog-client";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";

interface DomainData {
  domain: string | null;
  autoJoinEnabled: boolean;
}

export function DomainSettings() {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isPending } = useQuery<DomainData>({
    queryKey: KEYS.organizationDomain(org.id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "ORGANIZATION_DOMAIN_GET",
        arguments: {},
      });
      return unwrapToolResult<DomainData>(result);
    },
  });

  const userEmail = session?.user?.email ?? "";
  const userDomain = userEmail.split("@")[1]?.toLowerCase() ?? "";
  const currentDomain = data?.domain ?? null;
  const autoJoinEnabled = data?.autoJoinEnabled ?? false;
  const canClaim = userDomain && userDomain !== currentDomain;

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.organizationDomain(org.id),
    });

  const setDomainMutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "ORGANIZATION_DOMAIN_SET",
        arguments: { domain: userDomain, autoJoinEnabled: false },
      });
      return unwrapToolResult(result);
    },
    onSuccess: () => {
      track("organization_domain_claimed", {
        organization_id: org.id,
        email_domain: userDomain,
      });
      invalidate();
      toast.success("Domain claimed");
    },
    onError: (err) => {
      track("organization_domain_claim_failed", {
        organization_id: org.id,
        email_domain: userDomain,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(
        err instanceof Error ? err.message : "Failed to claim domain",
      );
    },
  });

  const clearDomainMutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "ORGANIZATION_DOMAIN_CLEAR",
        arguments: {},
      });
      return unwrapToolResult(result);
    },
    onSuccess: () => {
      track("organization_domain_cleared", {
        organization_id: org.id,
        email_domain: currentDomain,
      });
      invalidate();
      toast.success("Domain removed");
    },
    onError: (err) => {
      track("organization_domain_clear_failed", {
        organization_id: org.id,
        email_domain: currentDomain,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(
        err instanceof Error ? err.message : "Failed to remove domain",
      );
    },
  });

  const toggleAutoJoinMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!currentDomain) return;
      track("organization_auto_join_toggled", {
        organization_id: org.id,
        enabled,
      });
      const result = await client.callTool({
        name: "ORGANIZATION_DOMAIN_UPDATE",
        arguments: { autoJoinEnabled: enabled },
      });
      return unwrapToolResult(result);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Auto-join setting updated");
    },
    onError: (err) => {
      track("organization_auto_join_toggle_failed", {
        organization_id: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(
        err instanceof Error ? err.message : "Failed to update auto-join",
      );
    },
  });

  if (isPending) {
    return null;
  }

  return (
    <SettingsSection title="Email domain">
      {currentDomain ? (
        <SettingsCard>
          <SettingsCardItem
            title={currentDomain}
            description="Claimed domain"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => clearDomainMutation.mutate()}
                disabled={clearDomainMutation.isPending}
              >
                Remove
              </Button>
            }
          />
          <SettingsCardItem
            title="Auto-join"
            description={`Users with @${currentDomain} emails will automatically join this organization on signup.`}
            action={
              <Switch
                checked={autoJoinEnabled}
                onCheckedChange={(checked) =>
                  toggleAutoJoinMutation.mutate(checked)
                }
                disabled={toggleAutoJoinMutation.isPending}
              />
            }
          />
        </SettingsCard>
      ) : canClaim ? (
        <SettingsCard>
          <SettingsCardItem
            title={userDomain}
            description="Let new users with matching emails auto-join this org."
            action={
              <Button
                size="sm"
                onClick={() => setDomainMutation.mutate()}
                disabled={setDomainMutation.isPending}
              >
                {setDomainMutation.isPending ? "Claiming..." : "Claim domain"}
              </Button>
            }
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          <SettingsCardItem
            title="No domain detected"
            description="Sign in with a corporate email to claim a domain for your organization."
          />
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
