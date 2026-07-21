import { AccessScreenLayout } from "@/web/components/access-screen-layout";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Building02 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT } from "@/web/i18n/use-t.ts";

export interface AutoDomainJoinScreenProps {
  orgName: string;
  orgSlug: string;
  orgLogo: string | null;
  domain: string;
}

export function AutoDomainJoinScreen({
  orgName,
  orgSlug,
  orgLogo,
  domain,
}: AutoDomainJoinScreenProps) {
  const t = useT();
  const joinMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/custom/domain-join", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationSlug: orgSlug }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        slug?: string;
        error?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(
          data.error ?? t("common.autoDomainJoinScreen.joinError"),
        );
      }
      return data;
    },
    onSuccess: (data) => {
      window.location.href = `/${data.slug ?? orgSlug}`;
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.autoDomainJoinScreen.joinError"),
      );
    },
  });

  const handleGoHome = () => {
    window.location.href = "/";
  };

  return (
    <AccessScreenLayout>
      {orgLogo ? (
        <Avatar
          url={orgLogo}
          fallback={orgName.charAt(0).toUpperCase()}
          shape="square"
          size="base"
          className="h-12 w-12"
        />
      ) : (
        <div className="bg-primary/10 p-3 rounded-full">
          <Building02 className="h-6 w-6 text-primary" />
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.autoDomainJoinScreen.joinPrompt", { orgName })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.autoDomainJoinScreen.joinDescription", { domain })}
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full">
        <Button
          onClick={() => joinMutation.mutate()}
          disabled={joinMutation.isPending}
        >
          {joinMutation.isPending
            ? t("common.autoDomainJoinScreen.joining")
            : t("common.autoDomainJoinScreen.enterOrg", { orgName })}
        </Button>
        <Button
          variant="ghost"
          onClick={handleGoHome}
          disabled={joinMutation.isPending}
        >
          {t("common.autoDomainJoinScreen.goHome")}
        </Button>
      </div>
    </AccessScreenLayout>
  );
}
