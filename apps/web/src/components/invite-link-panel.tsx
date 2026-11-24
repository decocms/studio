import { Button } from "@decocms/ui/components/button.tsx";
import { Check, Copy01, Link03 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import {
  type ActiveInviteLink,
  useActiveInviteLinks,
  useInviteLinkActions,
} from "@/hooks/use-invite-links";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

function formatExpiry(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function CopyRow({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success(t("common.inviteLink.copied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {url}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        onClick={handleCopy}
        aria-label={t("common.inviteLink.copy")}
      >
        {copied ? (
          <Check size={12} className="text-success" />
        ) : (
          <Copy01 size={12} />
        )}
      </Button>
    </div>
  );
}

function ActiveLinkRow({ link }: { link: ActiveInviteLink }) {
  const t = useT();
  const { revoke } = useInviteLinkActions();
  return (
    <li className="flex items-center gap-2 text-xs">
      <Link03 size={14} className="shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">
          {link.redirectPath ?? "/"}
        </span>
        <span className="text-muted-foreground">
          {t("common.inviteLink.activeLinkMeta", {
            count: link.useCount,
            expiresAt: formatExpiry(link.expiresAt),
          })}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(link.id, {
            onSuccess: () => toast.success(t("common.inviteLink.revoked")),
            onError: () => toast.error(t("common.inviteLink.revokeFailed")),
          })
        }
      >
        {t("common.inviteLink.revoke")}
      </Button>
    </li>
  );
}

/**
 * Generates a 24-hour invite link anyone can use to join the org and land on
 * `redirectPath` (the org home when omitted).
 */
export function InviteLinkPanel({
  role,
  redirectPath,
  source,
  showActive = false,
}: {
  role: string;
  redirectPath?: string;
  source: "share_button" | "invite_dialog";
  showActive?: boolean;
}) {
  const t = useT();
  const { create, revoke } = useInviteLinkActions();
  const activeLinks = useActiveInviteLinks();
  const [created, setCreated] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);

  const handleCreate = () => {
    create.mutate(
      { role, redirectPath },
      {
        onSuccess: async (link) => {
          setCreated(link);
          track("invite_link_created", { role, source });
          try {
            await navigator.clipboard.writeText(link.url);
            toast.success(t("common.inviteLink.createdAndCopied"));
          } catch {
            toast.success(t("common.inviteLink.created"));
          }
        },
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : t("common.inviteLink.createFailed"),
          ),
      },
    );
  };

  const otherActive = activeLinks.filter((link) => link.id !== created?.id);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {created ? (
        <div className="flex flex-col gap-2">
          <CopyRow url={created.url} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t("common.inviteLink.expiresAt", {
                expiresAt: formatExpiry(created.expiresAt),
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(created.id, {
                  onSuccess: () => {
                    setCreated(null);
                    toast.success(t("common.inviteLink.revoked"));
                  },
                  onError: () =>
                    toast.error(t("common.inviteLink.revokeFailed")),
                })
              }
            >
              {t("common.inviteLink.revoke")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          disabled={create.isPending}
          onClick={handleCreate}
        >
          <Link03 size={16} />
          {create.isPending
            ? t("common.inviteLink.creating")
            : t("common.inviteLink.create")}
        </Button>
      )}

      {showActive && otherActive.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t("common.inviteLink.activeLinks")}
          </span>
          <ul className="flex flex-col gap-2">
            {otherActive.map((link) => (
              <ActiveLinkRow key={link.id} link={link} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
