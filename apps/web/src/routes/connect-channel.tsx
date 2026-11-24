/**
 * A bot in an outside channel (Slack, Discord…) sent the person this link so
 * it can talk to Studio as them. They check the account it names and click
 * Connect, signed in; then they go back to the channel, where their message
 * gets answered. Nothing is connected by opening the page.
 */
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  AlertTriangle,
  LinkBroken01,
  MessageChatSquare,
} from "@untitledui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { channelName } from "@/lib/channel-accounts";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool, StudioToolError } from "@/lib/studio-tools";

/** Back to the channels service: the server only accepts its own origin; never a script URL here. */
function goBack(url: string) {
  const target = URL.canParse(url) ? new URL(url) : null;
  if (target?.protocol === "https:" || target?.protocol === "http:") {
    window.location.href = target.href;
  }
}

function CenteredSpinner() {
  const t = useT();
  return (
    <div className="flex min-h-dvh w-full items-center justify-center">
      <Spinner
        className="size-5 text-muted-foreground"
        label={t("common.loading")}
      />
    </div>
  );
}

function Unavailable({ notMember }: { notMember: boolean }) {
  const t = useT();
  return (
    <AccessScreenLayout>
      <div className="rounded-full bg-muted p-3">
        <LinkBroken01 className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.connectChannelScreen.invalidTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {notMember
            ? t("common.connectChannelScreen.notMemberDescription")
            : t("common.connectChannelScreen.invalidDescription")}
        </p>
      </div>
      <Button variant="outline" onClick={() => (window.location.href = "/")}>
        {t("common.connectChannelScreen.goHome")}
      </Button>
    </AccessScreenLayout>
  );
}

export default function ConnectChannelRoute() {
  const t = useT();
  const navigate = useNavigate();
  const { org, claimId } = useParams({
    from: "/connect-channel/$org/$claimId",
  });
  const session = authClient.useSession();
  const user = session.data?.user ?? null;

  const claim = useQuery({
    queryKey: KEYS.channelAccountClaim(org, claimId, user?.id ?? null),
    queryFn: () =>
      callStudioTool(org, "CHANNEL_ACCOUNT_CLAIM_GET", { id: claimId }),
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const connect = useMutation({
    mutationFn: () =>
      callStudioTool(org, "CHANNEL_ACCOUNT_CONNECT", { id: claimId }),
    onSuccess: (data) => goBack(data.returnUrl),
    onError: (error) => toast.error(error.message),
  });

  if (session.isPending) return <CenteredSpinner />;

  if (!user) {
    return (
      <AccessScreenLayout>
        <div className="rounded-full bg-primary/10 p-3">
          <MessageChatSquare className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">
            {t("common.connectChannelScreen.signInTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("common.connectChannelScreen.signInDescription")}
          </p>
        </div>
        <Button
          className="w-full"
          onClick={() =>
            navigate({
              to: "/login",
              search: { next: `/connect-channel/${org}/${claimId}` },
            })
          }
        >
          {t("common.connectChannelScreen.signInButton")}
        </Button>
      </AccessScreenLayout>
    );
  }

  if (claim.isPending || connect.isSuccess) return <CenteredSpinner />;

  if (claim.isError || !claim.data.claim) {
    const notMember =
      claim.error instanceof StudioToolError && claim.error.status === 403;
    return <Unavailable notMember={notMember} />;
  }

  const { channel, accountName, accountWhere } = claim.data.claim;
  const name = channelName(channel);

  return (
    <AccessScreenLayout>
      <div className="rounded-full bg-primary/10 p-3">
        <MessageChatSquare className="h-6 w-6 text-primary" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.connectChannelScreen.title", { channel: name })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.connectChannelScreen.description", {
            channel: name,
            email: user.email,
          })}
        </p>
      </div>
      <div className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left">
        <p className="text-sm font-medium text-foreground">{accountName}</p>
        <p className="text-xs text-muted-foreground">
          {accountWhere ? `${name} · ${accountWhere}` : name}
        </p>
      </div>
      <p className="flex items-start gap-2 text-left text-sm text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {t("common.connectChannelScreen.warning")}
      </p>
      <div className="flex w-full flex-col gap-2">
        <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
          {connect.isPending
            ? t("common.connectChannelScreen.connecting")
            : t("common.connectChannelScreen.connectButton")}
        </Button>
        <Button
          variant="ghost"
          disabled={connect.isPending}
          onClick={() => (window.location.href = "/")}
        >
          {t("common.connectChannelScreen.notMine")}
        </Button>
      </div>
    </AccessScreenLayout>
  );
}
