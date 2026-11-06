/**
 * The project's "Blocks v8 site" switch, for org owners and admins only:
 * the one lever that makes a project v8 (`isBlocksV8Project`). On, every v8
 * gate opens (the hosted editor, Experiments, Calendar, Releases, site
 * tokens, Monitor) and `deco schema push` is accepted; off, the project is a
 * v7 site with main's editor. Nothing else turns it on, so other members
 * never see it. It saves on its own call (`blocksV8` on the update tool),
 * never through the settings form's metadata.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { toast } from "sonner";
import {
  SettingsCard,
  SettingsCardRow,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useCapabilities } from "@/hooks/use-capability";
import { useProjectMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { useT } from "@/i18n/use-t.ts";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

export function BlocksV8SiteSection({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { isPrivileged } = useCapabilities();
  const isV8 = useProjectMainSchemaV8(virtualMcp) === "v8";
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      studio.call("COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: virtualMcp.id,
        data: { blocksV8: on },
      }),
    onError: (error) => toast.error(error.message),
    // Every v8 gate reads the project row: refetch it.
    onSettled: () => invalidateVirtualMcpQueries(queryClient, org.id),
  });
  if (!isPrivileged) return null;
  const checked = toggle.isPending ? toggle.variables : isV8;
  return (
    <SettingsSection>
      <SettingsCard>
        <SettingsCardRow>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label
                htmlFor="blocks-v8-site"
                className="font-normal text-foreground"
              >
                {t("virtualMcp.settings.blocksV8Site.label")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("virtualMcp.settings.blocksV8Site.description")}
              </p>
            </div>
            <Switch
              id="blocks-v8-site"
              className="shrink-0"
              checked={checked}
              disabled={toggle.isPending}
              onCheckedChange={(on) => toggle.mutate(on)}
            />
          </div>
        </SettingsCardRow>
      </SettingsCard>
    </SettingsSection>
  );
}
