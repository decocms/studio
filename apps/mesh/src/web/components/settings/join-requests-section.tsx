import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  useJoinRequestActions,
  usePendingJoinRequests,
} from "@/web/hooks/use-join-requests";
import { useT } from "@/web/i18n/use-t.ts";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";

/**
 * Pending domain join requests, shown at the top of the members page so admins
 * see them first. Renders nothing when there are none.
 */
export function JoinRequestsSection() {
  const t = useT();
  const requests = usePendingJoinRequests();
  const { approve, deny } = useJoinRequestActions();

  if (requests.length === 0) return null;

  return (
    <SettingsSection
      title={t("settings.joinRequestsSection.title")}
      description={t("settings.joinRequestsSection.description")}
    >
      <SettingsCard>
        {requests.map((r) => (
          <SettingsCardItem
            key={r.id}
            icon={
              <Avatar
                url={r.user?.image ?? undefined}
                fallback={(r.user?.name ?? r.user?.email ?? "?")
                  .charAt(0)
                  .toUpperCase()}
                shape="circle"
                size="sm"
              />
            }
            title={r.user?.name ?? r.user?.email ?? r.userId}
            description={r.user?.email}
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => deny.mutate(r.id)}
                  disabled={deny.isPending || approve.isPending}
                >
                  {t("settings.joinRequestsSection.deny")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => approve.mutate(r.id)}
                  disabled={approve.isPending || deny.isPending}
                >
                  {t("settings.joinRequestsSection.approve")}
                </Button>
              </div>
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
