/**
 * Start a topic. The title takes slash commands: `/bounty Port the header`
 * picks a kind, `/score shop.com` asks deco for that site's Deco Score. A kind
 * fills the body with its template until the author edits it.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useTags } from "@/hooks/use-tags";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { parseTitle, slashCommands } from "./slash";
import { useForumMutations, type ForumChannel } from "./use-forum";

/** Kinds with a template; any other kind starts blank. */
const TEMPLATES: Record<string, TranslationKey> = {
  Proposal: "forum.template.proposal",
  Question: "forum.template.question",
  Role: "forum.template.role",
  Bounty: "forum.template.bounty",
  Gig: "forum.template.gig",
  Profile: "forum.template.profile",
  Help: "forum.template.help",
};

/** The org tag a `/score` topic wears, when the org has one. */
const SCORE_KIND = "Score";

export function NewTopicDialog({
  channels,
  defaultChannelId,
  onClose,
  onCreated,
}: {
  channels: ForumChannel[];
  /** The channel being read; the org timeline lets the author pick. */
  defaultChannelId?: string;
  onClose: () => void;
  onCreated: (topic: { id: string; keySeq: number | null }) => void;
}) {
  const t = useT();
  const tags = useTags();
  const { createTopic, score } = useForumMutations();
  const [channelId, setChannelId] = useState(
    defaultChannelId ?? channels[0]?.id ?? "",
  );
  const [kind, setKind] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const kinds = channels.find((c) => c.id === channelId)?.forum.kinds ?? [];
  /** On the org timeline a command names its channel too: `/bounty` lands in
   *  the channel that has bounties, `/score` in the one that has scores. */
  const commandKinds = defaultChannelId
    ? kinds
    : [...new Set(channels.flatMap((c) => c.forum.kinds))];
  const channelFor = (kind: string) =>
    channels.find((c) => c.forum.kinds.includes(kind))?.id;
  const parsed = parseTitle(title, commandKinds);
  const effectiveKind =
    parsed.type === "score" ? SCORE_KIND : (parsed.kind ?? kind);
  const commandMenu = /^\/\S*$/.test(title)
    ? slashCommands(commandKinds).filter((c) =>
        c.command.startsWith(title.slice(1).toLowerCase()),
      )
    : [];

  const templateFor = (name: string | null) => {
    const key = name ? TEMPLATES[name] : undefined;
    return key ? t(key) : "";
  };

  /** Only replace a body that is still the previous template (or empty). */
  const switchKind = (next: string | null) => {
    if (body.trim() === templateFor(effectiveKind).trim()) {
      setBody(templateFor(next));
    }
    setKind(next);
  };

  const changeTitle = (value: string) => {
    const next = parseTitle(value, commandKinds);
    const nextKind = next.type === "score" ? SCORE_KIND : next.kind;
    if (!defaultChannelId && nextKind) {
      const owner = channelFor(nextKind);
      if (owner && owner !== channelId) setChannelId(owner);
    }
    if (next.type === "topic" && next.kind && next.kind !== effectiveKind) {
      switchKind(next.kind);
    }
    setTitle(value);
  };

  const canPost =
    !!channelId &&
    (parsed.type === "score" ? !!parsed.domain : !!parsed.title) &&
    !createTopic.isPending;

  const submit = async () => {
    const tagId = tags.data?.find((tag) => tag.name === effectiveKind)?.id;
    try {
      const { item } = await createTopic.mutateAsync({
        virtualMcpId: channelId,
        title:
          parsed.type === "score"
            ? t("forum.scoreTitle", { domain: parsed.domain })
            : parsed.title,
        description: body.trim(),
        tagIds: tagId ? [tagId] : [],
      });
      if (parsed.type === "score") {
        await score.mutateAsync({ topicId: item.id, domain: parsed.domain });
      }
      onClose();
      onCreated(item);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forum.createFailed"));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("forum.newTopic")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canPost) void submit();
          }}
        >
          {channels.length > 1 && (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">
                {t("forum.channel")}
              </span>
              <select
                value={channelId}
                onChange={(event) => {
                  setChannelId(event.target.value);
                  setKind(null);
                }}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    # {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="relative">
            <Input
              autoFocus
              required
              maxLength={500}
              value={title}
              onChange={(event) => changeTitle(event.target.value)}
              placeholder={t("forum.titlePlaceholder")}
              aria-label={t("forum.titlePlaceholder")}
            />
            {commandMenu.length > 0 && (
              <ul
                aria-label={t("forum.commands")}
                className="absolute top-11 z-10 w-full overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md"
              >
                {commandMenu.map((c) => (
                  <li key={c.command}>
                    <button
                      type="button"
                      onClick={() => changeTitle(`/${c.command} `)}
                      className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-mono">/{c.command}</span>
                      <span className="text-muted-foreground">
                        {c.kind ?? t("forum.scoreCommand")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {kinds.length > 0 && parsed.type !== "score" && (
            <div className="flex flex-wrap gap-1.5">
              {kinds.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={effectiveKind === name}
                  onClick={() =>
                    switchKind(effectiveKind === name ? null : name)
                  }
                  className={cn(
                    "h-7 cursor-pointer rounded-full border px-3 text-xs transition-colors",
                    effectiveKind === name
                      ? "border-foreground/40 bg-muted text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {parsed.type === "score" ? (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              {parsed.domain
                ? t("forum.scoreHint", { domain: parsed.domain })
                : t("forum.scoreNeedsDomain")}
            </p>
          ) : (
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={t("forum.bodyPlaceholder")}
              aria-label={t("forum.bodyPlaceholder")}
              className="min-h-48 font-mono text-[13px]"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("forum.cancel")}
            </Button>
            <Button type="submit" disabled={!canPost}>
              {parsed.type === "score" ? t("forum.scorePost") : t("forum.post")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
