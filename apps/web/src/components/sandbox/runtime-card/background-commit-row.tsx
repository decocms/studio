import { toast } from "sonner";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { SettingsCardRow } from "@/components/settings/settings-section";
import { useCapability } from "@/hooks/use-capability";
import { useOrgFlag, useSetOrgFlag } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * The organization's `cms_background_commit` switch, offered in a project's
 * Preview card beside the per-project Fast Preview switches. It is an org
 * flag, saved when toggled rather than with the project form, so only members
 * who manage the organization see it. Hidden with `cms_auto_commit` off: saves
 * are then held until publish and there is no commit to wait for.
 */
export function BackgroundCommitRow() {
  const t = useT();
  const { granted } = useCapability("org:manage");
  const autoCommit = useOrgFlag("cms_auto_commit");
  const enabled = useOrgFlag("cms_background_commit");
  const setFlag = useSetOrgFlag();
  if (!granted || !autoCommit) return null;
  return (
    <SettingsCardRow>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5 min-w-0">
          <Label
            htmlFor="cms-background-commit"
            className="font-normal text-foreground"
          >
            {t("sandbox.cmsSettings.backgroundCommit.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("sandbox.cmsSettings.backgroundCommit.description")}
          </p>
        </div>
        <Switch
          id="cms-background-commit"
          className="shrink-0"
          checked={enabled}
          disabled={setFlag.isPending}
          onCheckedChange={(next) =>
            setFlag.mutate("cms_background_commit", next, {
              onError: () => toast.error(t("settings.review.updateError")),
            })
          }
        />
      </div>
    </SettingsCardRow>
  );
}
