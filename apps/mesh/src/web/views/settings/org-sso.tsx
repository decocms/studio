import { useState } from "react";
import { DomainSettings } from "@/web/components/settings/domain-settings";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useT } from "@/web/i18n/use-t.ts";
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
  const t = useT();
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
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

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
      toast.error(t("settings.orgSso.requiredFieldsError"));
      return;
    }

    if (!isConfigured && !formState.clientSecret) {
      toast.error(t("settings.orgSso.clientSecretRequiredError"));
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
      toast.success(t("settings.orgSso.configurationSavedSuccess"));
      setIsEditing(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.orgSso.saveSsoConfigError"),
      );
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      track("sso_config_removed", { organization_id: org.id });
      toast.success(t("settings.orgSso.configurationRemovedSuccess"));
      setIsEditing(false);
      setConfirmDeleteOpen(false);
    } catch {
      toast.error(t("settings.orgSso.removeSsoConfigError"));
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
        enforced
          ? t("settings.orgSso.enforcementEnabledSuccess")
          : t("settings.orgSso.enforcementDisabledSuccess"),
      );
    } catch {
      toast.error(t("settings.orgSso.toggleEnforcementError"));
    }
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.orgSso.securityTitle")}</Page.Title>
            <DomainSettings />
            {isLoading ? (
              <div className="text-sm text-muted-foreground">
                {t("settings.orgSso.loading")}
              </div>
            ) : (
              <>
                {/* Status */}
                {isConfigured && !isEditing && (
                  <SettingsSection title={t("settings.orgSso.sectionTitle")}>
                    <SettingsCard>
                      <SettingsCardItem
                        title={t("settings.orgSso.providerLabel")}
                        action={
                          <span className="font-medium">{config!.issuer}</span>
                        }
                      />
                      <SettingsCardItem
                        title={t("settings.orgSso.clientIdLabel")}
                        action={
                          <span className="font-mono text-xs">
                            {config!.clientId}
                          </span>
                        }
                      />
                      <SettingsCardItem
                        title={t("settings.orgSso.domainLabel")}
                        action={
                          <span className="font-medium">{config!.domain}</span>
                        }
                      />
                      <SettingsCardItem
                        title={t("settings.orgSso.scopesLabel")}
                        action={
                          <span className="font-mono text-xs">
                            {config!.scopes.join(" ")}
                          </span>
                        }
                      />
                      <div className="h-px bg-border mx-5" />
                      <SettingsCardItem
                        title={t("settings.orgSso.enforceSsoLabel")}
                        description={t("settings.orgSso.enforceSsoDescription")}
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
                          onClick={() => setConfirmDeleteOpen(true)}
                          disabled={deleteMutation.isPending}
                          className="text-destructive hover:text-destructive mr-auto"
                        >
                          <Trash01 size={14} />
                          {t("settings.orgSso.removeButton")}
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
                          {t("settings.orgSso.testSsoButton")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startEditing}
                        >
                          {t("settings.orgSso.editConfigButton")}
                        </Button>
                      </SettingsCardActions>
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* Form (new config or editing) */}
                {(!isConfigured || isEditing) && (
                  <SettingsSection title={t("settings.orgSso.sectionTitle")}>
                    <SettingsCard>
                      <SettingsCardItem
                        title={t("settings.orgSso.issuerUrlLabel")}
                        description={t("settings.orgSso.issuerUrlDescription")}
                        action={
                          <Input
                            id="sso-issuer"
                            placeholder={t(
                              "settings.orgSso.issuerUrlPlaceholder",
                            )}
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
                        title={t("settings.orgSso.clientIdLabel")}
                        action={
                          <Input
                            id="sso-client-id"
                            placeholder={t(
                              "settings.orgSso.clientIdPlaceholder",
                            )}
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
                        title={t("settings.orgSso.clientSecretLabel")}
                        description={
                          isEditing && isConfigured
                            ? t("settings.orgSso.clientSecretEditDescription")
                            : undefined
                        }
                        action={
                          <Input
                            id="sso-client-secret"
                            type="password"
                            placeholder={t(
                              "settings.orgSso.clientSecretPlaceholder",
                            )}
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
                        title={t("settings.orgSso.emailDomainLabel")}
                        description={t(
                          "settings.orgSso.emailDomainDescription",
                        )}
                        action={
                          <Input
                            id="sso-domain"
                            placeholder={t(
                              "settings.orgSso.emailDomainPlaceholder",
                            )}
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
                        title={t("settings.orgSso.scopesLabel")}
                        action={
                          <Input
                            id="sso-scopes"
                            placeholder={t("settings.orgSso.scopesPlaceholder")}
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
                        title={t("settings.orgSso.discoveryEndpointLabel")}
                        description={t(
                          "settings.orgSso.discoveryEndpointDescription",
                        )}
                        action={
                          <Input
                            id="sso-discovery"
                            placeholder={t(
                              "settings.orgSso.discoveryEndpointPlaceholder",
                            )}
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
                            {t("settings.orgSso.cancelButton")}
                          </Button>
                        )}
                        <Button
                          onClick={handleSave}
                          disabled={saveMutation.isPending}
                          size="sm"
                        >
                          {saveMutation.isPending
                            ? t("settings.orgSso.savingButton")
                            : isEditing
                              ? t("settings.orgSso.updateButton")
                              : t("settings.orgSso.configureSsoButton")}
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

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.orgSso.removeConfirmation")}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("settings.orgSso.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.orgSso.removeButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
