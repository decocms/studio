import { useState } from "react";
import { DomainSettings } from "@/web/components/settings/domain-settings";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  useOrgSsoConfig,
  useSaveOrgSsoConfig,
  useDeleteOrgSsoConfig,
  useToggleSsoEnforcement,
} from "@/web/hooks/use-org-sso";
import {
  SettingsCard,
  SettingsCardActions,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Trash01 } from "@untitledui/icons";
import { track } from "@/web/lib/posthog-client";

export function OrgSsoPage() {
  const { org } = useProjectContext();
  const { data: ssoData, isLoading } = useOrgSsoConfig(org.id, org.slug);
  const saveMutation = useSaveOrgSsoConfig(org.id, org.slug);
  const deleteMutation = useDeleteOrgSsoConfig(org.id, org.slug);
  const enforceMutation = useToggleSsoEnforcement(org.id, org.slug);

  const [formState, setFormState] = useState({
    issuer: "",
    clientId: "",
    clientSecret: "",
    discoveryEndpoint: "",
    domain: "",
    scopes: "openid email profile",
  });
  const [isEditing, setIsEditing] = useState(false);

  const isConfigured = ssoData?.configured && ssoData.config;
  const config = ssoData?.config;

  // Populate form when switching to edit mode
  const startEditing = () => {
    if (config) {
      setFormState({
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: "", // Don't populate secret
        discoveryEndpoint: config.discoveryEndpoint ?? "",
        domain: config.domain,
        scopes: config.scopes.join(" "),
      });
    }
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!formState.issuer || !formState.clientId || !formState.domain) {
      toast.error("Issuer, Client ID, and Domain are required");
      return;
    }

    if (!isConfigured && !formState.clientSecret) {
      toast.error("Client Secret is required for initial setup");
      return;
    }

    try {
      await saveMutation.mutateAsync({
        issuer: formState.issuer,
        clientId: formState.clientId,
        clientSecret: formState.clientSecret,
        discoveryEndpoint: formState.discoveryEndpoint || undefined,
        scopes: formState.scopes.split(/\s+/).filter(Boolean),
        domain: formState.domain,
        enforced: config?.enforced ?? false,
      });
      track(isConfigured ? "sso_config_updated" : "sso_configured", {
        organization_id: org.id,
        email_domain: formState.domain,
      });
      toast.success("SSO configuration saved");
      setIsEditing(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save SSO config",
      );
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to remove SSO configuration?")) return;
    try {
      await deleteMutation.mutateAsync();
      track("sso_config_removed", { organization_id: org.id });
      toast.success("SSO configuration removed");
      setIsEditing(false);
    } catch {
      toast.error("Failed to remove SSO config");
    }
  };

  const handleEnforceToggle = async (enforced: boolean) => {
    try {
      await enforceMutation.mutateAsync(enforced);
      track("sso_enforcement_toggled", {
        organization_id: org.id,
        enforced,
      });
      toast.success(
        enforced ? "SSO enforcement enabled" : "SSO enforcement disabled",
      );
    } catch {
      toast.error("Failed to toggle SSO enforcement");
    }
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Security</Page.Title>
            <DomainSettings />
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : (
              <>
                {/* Status */}
                {isConfigured && !isEditing && (
                  <SettingsSection title="Single Sign-On">
                    <SettingsCard>
                      <SettingsCardItem
                        title="Provider"
                        action={
                          <span className="font-medium">{config!.issuer}</span>
                        }
                      />
                      <SettingsCardItem
                        title="Client ID"
                        action={
                          <span className="font-mono text-xs">
                            {config!.clientId}
                          </span>
                        }
                      />
                      <SettingsCardItem
                        title="Domain"
                        action={
                          <span className="font-medium">{config!.domain}</span>
                        }
                      />
                      <SettingsCardItem
                        title="Scopes"
                        action={
                          <span className="font-mono text-xs">
                            {config!.scopes.join(" ")}
                          </span>
                        }
                      />
                      <div className="h-px bg-border mx-5" />
                      <SettingsCardItem
                        title="Enforce SSO"
                        description="Require all members to authenticate via SSO"
                        action={
                          <Switch
                            checked={config!.enforced}
                            onCheckedChange={handleEnforceToggle}
                            disabled={enforceMutation.isPending}
                          />
                        }
                      />
                      <SettingsCardActions>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleDelete}
                          disabled={deleteMutation.isPending}
                          className="text-destructive hover:text-destructive mr-auto"
                        >
                          <Trash01 size={14} />
                          Remove
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            window.open(
                              `/api/${org.slug}/sso/authorize`,
                              "_blank",
                            );
                          }}
                        >
                          Test SSO
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startEditing}
                        >
                          Edit configuration
                        </Button>
                      </SettingsCardActions>
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* Form (new config or editing) */}
                {(!isConfigured || isEditing) && (
                  <SettingsSection title="Single Sign-On">
                    <SettingsCard>
                      <SettingsCardItem
                        title="Issuer URL"
                        description="The OIDC issuer URL of your identity provider."
                        action={
                          <Input
                            id="sso-issuer"
                            placeholder="https://login.microsoftonline.com/{tenant}/v2.0"
                            value={formState.issuer}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                issuer: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardItem
                        title="Client ID"
                        action={
                          <Input
                            id="sso-client-id"
                            placeholder="your-client-id"
                            value={formState.clientId}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                clientId: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardItem
                        title="Client Secret"
                        description={
                          isEditing && isConfigured
                            ? "Leave empty to keep current"
                            : undefined
                        }
                        action={
                          <Input
                            id="sso-client-secret"
                            type="password"
                            placeholder="your-client-secret"
                            value={formState.clientSecret}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                clientSecret: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardItem
                        title="Email Domain"
                        description="The email domain this SSO provider covers."
                        action={
                          <Input
                            id="sso-domain"
                            placeholder="company.com"
                            value={formState.domain}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                domain: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardItem
                        title="Scopes"
                        action={
                          <Input
                            id="sso-scopes"
                            placeholder="openid email profile"
                            value={formState.scopes}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                scopes: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardItem
                        title="Discovery Endpoint"
                        description="Optional — auto-detected from issuer if omitted."
                        action={
                          <Input
                            id="sso-discovery"
                            placeholder="Auto-detected from issuer"
                            value={formState.discoveryEndpoint}
                            onChange={(e) =>
                              setFormState((s) => ({
                                ...s,
                                discoveryEndpoint: e.target.value,
                              }))
                            }
                            className="w-[280px]"
                          />
                        }
                      />
                      <SettingsCardActions>
                        {isEditing && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setIsEditing(false)}
                          >
                            Cancel
                          </Button>
                        )}
                        <Button
                          onClick={handleSave}
                          disabled={saveMutation.isPending}
                          size="sm"
                        >
                          {saveMutation.isPending
                            ? "Saving..."
                            : isEditing
                              ? "Update"
                              : "Configure SSO"}
                        </Button>
                      </SettingsCardActions>
                    </SettingsCard>
                  </SettingsSection>
                )}
              </>
            )}
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
