/** Import an existing codebase, or start an empty project folder to connect later. Repository picks hand off to `RepositoryImportPicker` rather than nesting a dialog in a dialog. */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { RepositoryImportPicker } from "@/components/repository-import-picker.tsx";
import { FolderArt, RepositoryArt } from "@/components/projects/project-art";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { useVirtualMCPActions } from "@/sdk";

/** The intents on the first step. `repository` hands off; `folder` asks a name. */
type CreationPath = "repository" | "folder";

interface PathMeta {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  art: (props: { className?: string }) => ReactNode;
  /**
   * The card's hue, from the design system's CATEGORICAL palette.
   *
   * `chart-*` rather than `success` / `warning`: those are status, and a
   * storefront is not a healthier thing to make than a report. These four say
   * only "different intent", which is the whole job, and they are the same
   * values in both themes. Written as whole class names because Tailwind reads
   * source text and cannot see an interpolated one.
   */
  plate: string;
  art_: string;
}

const PATHS: Record<CreationPath, PathMeta> = {
  repository: {
    titleKey: "projects.new.path.repository",
    hintKey: "projects.new.path.repository.hint",
    art: RepositoryArt,
    plate: "bg-chart-5/10 group-hover:bg-chart-5/16",
    art_: "text-chart-5",
  },
  folder: {
    titleKey: "projects.new.path.folder",
    hintKey: "projects.new.path.folder.hint",
    art: FolderArt,
    plate: "bg-chart-1/10 group-hover:bg-chart-1/16",
    art_: "text-chart-1",
  },
};

const PATH_ORDER = ["repository", "folder"] as const;

function PathCard({
  path,
  onSelect,
}: {
  path: CreationPath;
  onSelect: () => void;
}) {
  const t = useT();
  const meta = PATHS[path];
  const Art = meta.art;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col gap-3 rounded-xl bg-card p-3 text-left card-shadow outline-none transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      {/* The scene sits on its own tinted plate, in the card's own hue, so the
          two intents are told apart before a word is read. */}
      <span
        className={cn(
          "flex h-28 items-center justify-center rounded-lg transition-colors",
          meta.plate,
          meta.art_,
        )}
      >
        <Art className="h-20" />
      </span>
      <span className="flex flex-col gap-0.5 px-1 pb-1">
        <span className="text-sm font-medium text-foreground">
          {t(meta.titleKey)}
        </span>
        <span className="text-xs text-muted-foreground">{t(meta.hintKey)}</span>
      </span>
    </button>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NewProjectDialog({
  open,
  onOpenChange,
  source = "org_home",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `project_create_*` analytics source. */
  source?: string;
}) {
  const t = useT();
  const actions = useVirtualMCPActions();
  const navigateToAgent = useNavigateToAgent();

  const [path, setPath] = useState<CreationPath | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const reset = () => {
    setPath(null);
    setName("");
    setError(null);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  /** The repository path is a different dialog, so ours is closed while it is
   *  up — never both at once. */
  if (path === "repository") {
    return (
      <RepositoryImportPicker
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        onImportComplete={({ virtualMcpId }) => {
          if (virtualMcpId) navigateToAgent(virtualMcpId);
          close();
        }}
      />
    );
  }

  const create = async () => {
    const title = name.trim();
    if (!title) {
      setError(t("projects.new.nameRequired"));
      return;
    }
    try {
      const created = await actions.create.mutateAsync({
        title,
        description: null,
        status: "active",
        pinned: false,
        connections: [],
        metadata: {
          instructions: null,
          project: { storeUrl: null },
          ui: {
            pinnedViews: null,
            layout: {
              defaultMainView: { type: "overview" },
              chatDefaultOpen: true,
            },
          },
        },
      } as never);
      const id = (created as { id?: string } | undefined)?.id;
      track("project_created", { source, path });
      close();
      if (id) navigateToAgent(id);
      toast.success(t("projects.new.created", { title }));
    } catch {
      setError(t("projects.new.failed"));
    }
  };

  const stepTitleKey: TranslationKey = "projects.new.step.folder.title";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      {/* Opening a chooser should not single out one of its options, and the
          first card is what the default autofocus lands on. The content itself
          takes the focus, so Esc and Tab still work from the first keystroke. */}
      <DialogContent
        className="sm:max-w-3xl"
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("projects.new.title")}</DialogTitle>
          <DialogDescription>
            {path ? t(stepTitleKey) : t("projects.new.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {path === null ? (
          <div className="grid grid-cols-1 gap-3 animate-in fade-in-0 duration-200 sm:grid-cols-2 motion-reduce:animate-none">
            {PATH_ORDER.map((key) => (
              <PathCard
                key={key}
                path={key}
                onSelect={() => {
                  track("project_create_path_selected", {
                    source,
                    path: key,
                  });
                  setPath(key);
                }}
              />
            ))}
          </div>
        ) : (
          <form
            className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              void create();
            }}
          >
            <Field label={t("projects.new.nameLabel")}>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("projects.new.namePlaceholder")}
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => reset()}>
                <ArrowLeft size={14} />
                {t("projects.new.back")}
              </Button>
              <Button type="submit" disabled={actions.create.isPending}>
                {actions.create.isPending
                  ? t("projects.new.creating")
                  : t("projects.new.create")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The one control that opens the dialog, so every surface that offers to make
 *  a project offers the same thing. The dialog itself is mounted once by the
 *  shell — see `new-project-store.ts`. */
export function NewProjectButton({
  source,
  variant = "default",
  size = "sm",
  label,
}: {
  source: string;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default" | "lg";
  label?: string;
}) {
  const t = useT();
  return (
    <Button
      size={size}
      variant={variant}
      onClick={() => openNewProjectDialog(source)}
    >
      <Plus size={14} />
      {label ?? t("projects.home.newProject")}
    </Button>
  );
}
