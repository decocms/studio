import { track } from "@/lib/posthog-client";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

type JoinMode = "off" | "auto" | "request";

/** Explains what each join mode does, for the description under a verified domain. */
function joinModeHelp(mode: JoinMode, domain: string, t: TFunction): string {
  switch (mode) {
    case "auto":
      return t("settings.domainSettings.joinModeHelpAuto", { domain });
    case "request":
      return t("settings.domainSettings.joinModeHelpRequest", { domain });
    default:
      return t("settings.domainSettings.joinModeHelpOff");
  }
}

export function DomainSettings() {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const studio = useStudioTools();
  const [newDomain, setNewDomain] = useState("");

  const { data: domainsData, isPending } = useQuery({
    queryKey: KEYS.organizationDomains(org.id),
    queryFn: () => studio.call("ORGANIZATION_DOMAIN_LIST", {}),
  });

  const invalidateDomains = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.organizationDomains(org.id),
    });

  const addMutation = useMutation({
    mutationFn: (domain: string) =>
      studio.call("ORGANIZATION_DOMAIN_ADD", { domain }),
    onSuccess: () => {
      track("organization_domain_added", { organization_id: org.id });
      setNewDomain("");
      invalidateDomains();
      toast.success(t("settings.domainSettings.domainAdded"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.domainSettings.failedAddDomain"),
      ),
  });

  const updateModeMutation = useMutation({
    mutationFn: ({ id, joinMode }: { id: string; joinMode: JoinMode }) =>
      studio.call("ORGANIZATION_DOMAIN_UPDATE", { id, joinMode }),
    onSuccess: () => {
      invalidateDomains();
      toast.success(t("settings.domainSettings.joinModeUpdated"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.domainSettings.failedUpdate"),
      ),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) =>
      studio.call("ORGANIZATION_DOMAIN_VERIFY", { id }),
    onSuccess: (result) => {
      invalidateDomains();
      if (result.verified) {
        toast.success(t("settings.domainSettings.domainVerified"));
      } else {
        toast.error(t("settings.domainSettings.txtRecordNotFound"));
      }
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.domainSettings.failedVerify"),
      ),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      studio.call("ORGANIZATION_DOMAIN_REMOVE", { id }),
    onSuccess: () => {
      invalidateDomains();
      toast.success(t("settings.domainSettings.domainRemoved"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.domainSettings.failedRemove"),
      ),
  });

  if (isPending) return null;

  const domains = domainsData?.domains ?? [];

  return (
    <SettingsSection
      title={t("settings.domainSettings.emailDomains")}
      description={t("settings.domainSettings.emailDomainsDescription")}
    >
      <SettingsCard>
        {domains.map((d) => {
          const verified = d.verificationStatus === "verified";
          return (
            <SettingsCardItem
              key={d.id}
              title={
                <span className="flex items-center gap-2">
                  {d.domain}
                  {verified ? (
                    <Badge variant="secondary">
                      {t("settings.domainSettings.verified")}
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      {t("settings.domainSettings.pending")}
                    </Badge>
                  )}
                </span>
              }
              description={
                verified
                  ? joinModeHelp(d.joinMode, d.domain, t)
                  : t("settings.domainSettings.addDnsRecordInstruction")
              }
              action={
                <div className="flex items-center gap-2">
                  {verified && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        {t("settings.domainSettings.joinMode")}
                      </span>
                      <Select
                        value={d.joinMode}
                        onValueChange={(value) =>
                          updateModeMutation.mutate({
                            id: d.id,
                            joinMode: value as JoinMode,
                          })
                        }
                      >
                        <SelectTrigger className="w-44" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">
                            {t("settings.domainSettings.joinModeOff")}
                          </SelectItem>
                          <SelectItem value="auto">
                            {t("settings.domainSettings.joinModeAuto")}
                          </SelectItem>
                          <SelectItem value="request">
                            {t("settings.domainSettings.joinModeRequest")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  {!verified && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => verifyMutation.mutate(d.id)}
                      disabled={verifyMutation.isPending}
                    >
                      {t("settings.domainSettings.verify")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeMutation.mutate(d.id)}
                    disabled={removeMutation.isPending}
                  >
                    {t("settings.domainSettings.remove")}
                  </Button>
                </div>
              }
            >
              {!verified && d.recordName && d.recordValue && (
                <DnsInstructions
                  recordName={d.recordName}
                  recordValue={d.recordValue}
                />
              )}
            </SettingsCardItem>
          );
        })}
        <div className="flex items-center gap-2 p-4">
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder={t("settings.domainSettings.domainPlaceholder")}
            className="max-w-xs"
          />
          <Button
            size="sm"
            onClick={() => addMutation.mutate(newDomain.trim())}
            disabled={!newDomain.trim() || addMutation.isPending}
          >
            {addMutation.isPending
              ? t("settings.domainSettings.adding")
              : t("settings.domainSettings.addDomain")}
          </Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function DnsInstructions({
  recordName,
  recordValue,
}: {
  recordName: string;
  recordValue: string;
}) {
  const t = useT();
  const copy = (value: string) => {
    navigator.clipboard?.writeText(value);
    toast.success(t("settings.domainSettings.copied"));
  };
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-2">
      <p className="text-muted-foreground">
        {t("settings.domainSettings.dnsInstructions")}
      </p>
      <div className="grid gap-1">
        <button
          type="button"
          className="text-left font-mono break-all hover:underline"
          onClick={() => copy(recordName)}
        >
          <span className="text-muted-foreground">
            {t("settings.domainSettings.txt")}{" "}
          </span>
          {recordName}
        </button>
        <button
          type="button"
          className="text-left font-mono break-all hover:underline"
          onClick={() => copy(recordValue)}
        >
          <span className="text-muted-foreground">
            {t("settings.domainSettings.value")}{" "}
          </span>
          {recordValue}
        </button>
      </div>
    </div>
  );
}
