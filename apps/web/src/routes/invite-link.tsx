import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { LinkBroken01, Mail01 } from "@untitledui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { z } from "zod";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { useT } from "@/i18n/use-t.ts";
import { authClient, invalidateOrganizationListCache } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";

const organizationSchema = z.object({
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
});

const previewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-found") }),
  z.object({
    status: z.enum(["valid", "expired", "revoked"]),
    organization: organizationSchema,
    alreadyMember: z.boolean(),
    redirectPath: z.string().nullable(),
  }),
]);

const acceptSchema = z.object({
  success: z.literal(true),
  redirectPath: z.string(),
});

/** Only same-origin paths; the server already keeps them inside the org. */
function safePath(path: string | null | undefined) {
  return path?.startsWith("/") &&
    !path.startsWith("//") &&
    !path.startsWith("/\\")
    ? path
    : "/";
}

function goTo(path: string) {
  // A full load so the shell re-reads org membership.
  invalidateOrganizationListCache();
  window.location.href = safePath(path);
}

function inviteLinkUrl(token: string, suffix = "") {
  return `/api/auth/custom/invite-link/${encodeURIComponent(token)}${suffix}`;
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

function InvalidInvite() {
  const t = useT();
  return (
    <AccessScreenLayout>
      <div className="rounded-full bg-muted p-3">
        <LinkBroken01 className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.inviteLinkScreen.invalidTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.inviteLinkScreen.invalidDescription")}
        </p>
      </div>
      <Button variant="outline" onClick={() => goTo("/")}>
        {t("common.inviteLinkScreen.goHome")}
      </Button>
    </AccessScreenLayout>
  );
}

export default function InviteLinkRoute() {
  const t = useT();
  const navigate = useNavigate();
  const { token } = useParams({ from: "/invite/$token" });
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? null;

  const preview = useQuery({
    queryKey: KEYS.inviteLinkPreview(token, userId),
    queryFn: async () => {
      const res = await fetch(inviteLinkUrl(token), {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`invite-link failed (${res.status})`);
      return previewSchema.parse(await res.json());
    },
    enabled: !session.isPending,
    refetchOnWindowFocus: false,
  });

  const accept = useMutation({
    mutationFn: async () => {
      const res = await fetch(inviteLinkUrl(token, "/accept"), {
        method: "POST",
        credentials: "include",
      });
      const body = acceptSchema.safeParse(await res.json().catch(() => null));
      if (!res.ok || !body.success) {
        throw new Error(t("common.inviteLinkScreen.failedToJoin"));
      }
      return body.data;
    },
    onSuccess: (data) => goTo(data.redirectPath),
    onError: (error) => toast.error(error.message),
  });

  if (session.isPending || preview.isPending) return <CenteredSpinner />;

  if (preview.isError) return <InvalidInvite />;
  const data = preview.data;
  if (data.status === "not-found") return <InvalidInvite />;

  if (data.alreadyMember) {
    goTo(data.redirectPath ?? `/${data.organization.slug}`);
    return <CenteredSpinner />;
  }

  if (data.status !== "valid") return <InvalidInvite />;

  const { organization } = data;
  const signedIn = !!session.data;

  return (
    <AccessScreenLayout>
      {organization.logo ? (
        <Avatar
          url={organization.logo}
          fallback={organization.name}
          shape="square"
          size="base"
          className="h-12 w-12"
        />
      ) : (
        <div className="rounded-full bg-primary/10 p-3">
          <Mail01 className="h-6 w-6 text-primary" />
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.inviteLinkScreen.title", { orgName: organization.name })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {signedIn
            ? t("common.inviteLinkScreen.joinDescription", {
                email: session.data?.user.email ?? "",
              })
            : t("common.inviteLinkScreen.signInDescription")}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {signedIn ? (
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending
              ? t("common.inviteLinkScreen.joining")
              : t("common.inviteLinkScreen.joinButton", {
                  orgName: organization.name,
                })}
          </Button>
        ) : (
          <Button
            onClick={() =>
              navigate({
                to: "/login",
                search: { next: `/invite/${token}` },
              })
            }
          >
            {t("common.inviteLinkScreen.signInButton")}
          </Button>
        )}
      </div>
    </AccessScreenLayout>
  );
}
