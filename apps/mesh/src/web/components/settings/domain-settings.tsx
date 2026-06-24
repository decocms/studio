import { track } from "@/web/lib/posthog-client";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

type JoinMode = "off" | "auto" | "request";

const JOIN_MODE_LABELS: Record<JoinMode, string> = {
  off: "Off",
  auto: "Auto-join",
  request: "Require approval",
};

/** Explains what each join mode does, for the description under a verified domain. */
function joinModeHelp(mode: JoinMode, domain: string): string {
  switch (mode) {
    case "auto":
      return `Anyone with a verified @${domain} email joins automatically.`;
    case "request":
      return `People with a verified @${domain} email can request to join; an admin approves.`;
    default:
      return "Not discoverable — no one can find or join through this domain.";
  }
}

export function DomainSettings() {
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
      toast.success("Domain added");
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to add domain"),
  });

  const updateModeMutation = useMutation({
    mutationFn: ({ id, joinMode }: { id: string; joinMode: JoinMode }) =>
      studio.call("ORGANIZATION_DOMAIN_UPDATE", { id, joinMode }),
    onSuccess: () => {
      invalidateDomains();
      toast.success("Join mode updated");
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to update"),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) =>
      studio.call("ORGANIZATION_DOMAIN_VERIFY", { id }),
    onSuccess: (result) => {
      invalidateDomains();
      if (result.verified) {
        toast.success("Domain verified");
      } else {
        toast.error("TXT record not found yet — DNS can take a few minutes.");
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to verify"),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      studio.call("ORGANIZATION_DOMAIN_REMOVE", { id }),
    onSuccess: () => {
      invalidateDomains();
      toast.success("Domain removed");
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to remove"),
  });

  if (isPending) return null;

  const domains = domainsData?.domains ?? [];

  return (
    <SettingsSection
      title="Email domains"
      description="Let people with a matching email domain discover and join this organization."
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
                    <Badge variant="secondary">Verified</Badge>
                  ) : (
                    <Badge variant="outline">Pending</Badge>
                  )}
                </span>
              }
              description={
                verified
                  ? joinModeHelp(d.joinMode, d.domain)
                  : "Add the DNS record below, then verify."
              }
              action={
                <div className="flex items-center gap-2">
                  {verified && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Join mode
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
                          {(["off", "auto", "request"] as JoinMode[]).map(
                            (mode) => (
                              <SelectItem key={mode} value={mode}>
                                {JOIN_MODE_LABELS[mode]}
                              </SelectItem>
                            ),
                          )}
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
                      Verify
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeMutation.mutate(d.id)}
                    disabled={removeMutation.isPending}
                  >
                    Remove
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
            placeholder="acme.com"
            className="max-w-xs"
          />
          <Button
            size="sm"
            onClick={() => addMutation.mutate(newDomain.trim())}
            disabled={!newDomain.trim() || addMutation.isPending}
          >
            {addMutation.isPending ? "Adding…" : "Add domain"}
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
  const copy = (value: string) => {
    navigator.clipboard?.writeText(value);
    toast.success("Copied");
  };
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-2">
      <p className="text-muted-foreground">
        Add this TXT record at your DNS provider, then click Verify:
      </p>
      <div className="grid gap-1">
        <button
          type="button"
          className="text-left font-mono break-all hover:underline"
          onClick={() => copy(recordName)}
        >
          <span className="text-muted-foreground">TXT </span>
          {recordName}
        </button>
        <button
          type="button"
          className="text-left font-mono break-all hover:underline"
          onClick={() => copy(recordValue)}
        >
          <span className="text-muted-foreground">value </span>
          {recordValue}
        </button>
      </div>
    </div>
  );
}
