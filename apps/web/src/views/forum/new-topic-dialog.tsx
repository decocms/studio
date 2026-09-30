/** Start a topic. Picking a kind fills the body with that kind's template
 *  until the author edits it. */

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
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useForumMutations } from "./use-forum";

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

export function NewTopicDialog({
  project,
  onClose,
  onCreated,
}: {
  project: VirtualMCPEntity;
  onClose: () => void;
  onCreated: (topic: { id: string; keySeq: number | null }) => void;
}) {
  const t = useT();
  const tags = useTags();
  const { createTopic } = useForumMutations();
  const [kind, setKind] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const kinds = project.metadata?.forum?.kinds ?? [];

  const templateFor = (name: string | null) => {
    const key = name ? TEMPLATES[name] : undefined;
    return key ? t(key) : "";
  };

  const pickKind = (name: string) => {
    const next = kind === name ? null : name;
    // Only replace a body that is still the previous template (or empty).
    if (body.trim() === templateFor(kind).trim()) setBody(templateFor(next));
    setKind(next);
  };

  const submit = async () => {
    const tagId = tags.data?.find((tag) => tag.name === kind)?.id;
    try {
      const { item } = await createTopic.mutateAsync({
        projectId: project.id,
        title: title.trim(),
        description: body.trim(),
        tagIds: tagId ? [tagId] : [],
      });
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
          <DialogTitle>
            {t("forum.newTopicIn", { channel: project.title })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {kinds.length > 0 && (
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("forum.kind")}</span>
              <div className="flex flex-wrap gap-1.5">
                {kinds.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={kind === name}
                    onClick={() => pickKind(name)}
                    className={cn(
                      "h-7 cursor-pointer rounded-full border px-3 text-xs transition-colors",
                      kind === name
                        ? "border-foreground/40 bg-muted text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Input
            autoFocus
            required
            maxLength={500}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("forum.titlePlaceholder")}
            aria-label={t("forum.titlePlaceholder")}
          />
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t("forum.bodyPlaceholder")}
            aria-label={t("forum.bodyPlaceholder")}
            className="min-h-48 font-mono text-[13px]"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("forum.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || createTopic.isPending}
            >
              {t("forum.post")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
