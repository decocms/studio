import { useState } from "react";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  useOrgSsoConfig,
  useSaveOrgSsoConfig,
  useDeleteOrgSsoConfig,
  useToggleSsoEnforcement,
} from "@/web/hooks/use-org-sso";
import { CheckCircle, AlertCircle, Trash01 } from "@untitledui/icons";

export function OrgSsoPage() {
  const { org } = useProjectContext();
  const { data: ssoData, isLoading } = useOrgSsoConfig(org.id);
  const saveMutation = useSaveOrgSsoConfig(org.id);
  const deleteMutation = useDeleteOrgSsoConfig(org.id);
  const enforceMutation = useToggleSsoEnforcement(org.id);

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
      toast.success("SSO configuration removed");
      setIsEditing(false);
    } catch {
      toast.error("Failed to remove SSO config");
    }
  };

  const handleEnforceToggle = async (enforced: boolean) => {
    try {
      await enforceMutation.mutateAsync(enforced);
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
          <div className="flex flex-col gap-6">
            <Page.Title>Single Sign-On</Page.Title>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Status */}
                {isConfigured && !isEditing && (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
                      <CheckCircle size={16} className="text-green-600" />
                      <span className="text-sm font-medium">
                        SSO Configured
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {config!.issuer}
                      </span>
                    </div>

                    <div className="flex flex-col gap-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Provider</span>
                        <span className="font-medium">{config!.issuer}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Client ID</span>
                        <span className="font-mono text-xs">
                          {config!.clientId}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Domain</span>
                        <span className="font-medium">{config!.domain}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Scopes</span>
                        <span className="font-mono text-xs">
                          {config!.scopes.join(" ")}
                        </span>
                      </div>
                    </div>

                    {/* Enforce toggle */}
                    <div className="flex items-center justify-between p-3 rounded-md border border-border">
                      <div>
                        <p className="text-sm font-medium">Enforce SSO</p>
                        <p className="text-xs text-muted-foreground">
                          Require all members to authenticate via SSO
                        </p>
                      </div>
                      <Switch
                        checked={config!.enforced}
                        onCheckedChange={handleEnforceToggle}
                        disabled={enforceMutation.isPending}
                      />
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={startEditing}
                      >
                        Edit configuration
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          window.open(
                            `/api/org-sso/authorize?orgId=${org.id}`,
                            "_blank",
                          );
                        }}
                      >
                        Test SSO
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleteMutation.isPending}
                        className="text-destructive hover:text-destructive ml-auto"
                      >
                        <Trash01 size={14} />
                        Remove
                      </Button>
                    </div>
                  </div>
                )}

                {/* Form (new config or editing) */}
                {(!isConfigured || isEditing) && (
                  <div className="flex flex-col gap-4">
                    {!isConfigured && (
                      <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
                        <AlertCircle
                          size={16}
                          className="text-muted-foreground"
                        />
                        <span className="text-sm text-muted-foreground">
                          SSO is not configured for this organization.
                        </span>
                      </div>
                    )}

                    <div className="flex flex-col gap-5">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="sso-issuer">Issuer URL</Label>
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
                        />
                        <p className="text-xs text-muted-foreground">
                          The OIDC issuer URL of your identity provider.
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-5">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="sso-client-id">Client ID</Label>
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
                          />
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="sso-client-secret">
                            Client Secret
                            {isEditing && isConfigured && (
                              <span className="text-muted-foreground font-normal ml-1">
                                (leave empty to keep current)
                              </span>
                            )}
                          </Label>
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
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-5">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="sso-domain">Email Domain</Label>
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
                          />
                          <p className="text-xs text-muted-foreground">
                            The email domain that this SSO provider covers.
                          </p>
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="sso-scopes">Scopes</Label>
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
                          />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="sso-discovery">
                          Discovery Endpoint{" "}
                          <span className="text-muted-foreground font-normal">
                            (optional)
                          </span>
                        </Label>
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
                        />
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <Button
                        onClick={handleSave}
                        disabled={saveMutation.isPending}
                      >
                        {saveMutation.isPending
                          ? "Saving..."
                          : isEditing
                            ? "Update"
                            : "Configure SSO"}
                      </Button>
                      {isEditing && (
                        <Button
                          variant="ghost"
                          onClick={() => setIsEditing(false)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
