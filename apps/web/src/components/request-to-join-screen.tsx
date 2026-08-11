import { AccessScreenLayout } from "@/components/access-screen-layout";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Building02 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";

export interface RequestToJoinScreenProps {
  orgName: string;
  orgSlug: string;
  orgLogo: string | null;
  domain: string;
}

export function RequestToJoinScreen({
  orgName,
  orgSlug,
  orgLogo,
  domain,
}: RequestToJoinScreenProps) {
  const t = useT();
  const requestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/custom/domain-request-join", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationSlug: orgSlug }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        slug?: string;
        alreadyMember?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Failed to request access");
      }
      return data;
    },
    onSuccess: (data) => {
      if (data.alreadyMember && data.slug) {
        window.location.href = `/${data.slug}`;
        return;
      }
      // Re-evaluate access status — the gate now resolves to request-pending.
      window.location.reload();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.requestToJoinScreen.failedToRequest"),
      );
    },
  });

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
          {t("common.requestToJoinScreen.title", { orgName })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.requestToJoinScreen.description", { domain })}
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full">
        <Button
          onClick={() => requestMutation.mutate()}
          disabled={requestMutation.isPending}
        >
          {requestMutation.isPending
            ? t("common.requestToJoinScreen.requesting")
            : t("common.requestToJoinScreen.requestButton")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            window.location.href = "/";
          }}
          disabled={requestMutation.isPending}
        >
          {t("common.requestToJoinScreen.goToHome")}
        </Button>
      </div>
    </AccessScreenLayout>
  );
}
