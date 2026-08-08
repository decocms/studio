/**
 * Share controls for Library files and folders — pick a visibility mode and
 * copy the proxy link.
 *
 * Three modes: org-only (private), public (anyone with the link), and password
 * (anyone with the link AND the password — the `/read` proxy serves a form
 * first). On a folder the mode governs the whole subtree (the read proxy
 * resolves the most-specific published ancestor). Changing mode never moves
 * anything — the same `/api/:org/fs/:volume/read?path=…` link just changes who
 * it works for.
 *
 * Two surfaces share one body (`ShareControls`): `FileShareButton` (the
 * preview-toolbar popover) and `ShareDialog` (opened from Library cards).
 */

import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Check,
  Copy01,
  Globe01,
  Key01,
  Lock01,
  Share07,
} from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import {
  type ShareMode,
  useOrgFsSetShareMode,
  useOrgFsStat,
} from "@/hooks/use-org-fs";

export interface ShareTarget {
  volume: string;
  /** In-volume path of the file or folder. */
  path: string;
  kind: "file" | "dir";
  /** Last-known own mode — seeds the control until the live stat loads. */
  shareMode: ShareMode;
  /** Last-known effective-public (own or inherited) — seeds the inherited note. */
  effectivePublic: boolean;
  /** Absolute proxy link to copy. Files only; folders have no single URL. */
  url?: string;
}

const MODES = [
  {
    mode: "private",
    labelKey: "library.fileShareButton.modeOrgOnly",
    Icon: Lock01,
  },
  {
    mode: "public",
    labelKey: "library.fileShareButton.modePublic",
    Icon: Globe01,
  },
  {
    mode: "password",
    labelKey: "library.fileShareButton.modePassword",
    Icon: Key01,
  },
] as const satisfies {
  mode: ShareMode;
  labelKey: string;
  Icon: typeof Globe01;
}[];

/** The shared body: a 3-way mode control, an optional password field, and (for
 *  files) a copy-link row. */
function ShareControls({
  volume,
  path,
  kind,
  shareMode,
  effectivePublic,
  url,
}: ShareTarget) {
  const t = useT();
  const setShareMode = useOrgFsSetShareMode(volume);
  // Read live state so the control reflects the optimistic change immediately
  // (the mutation writes this exact stat key), seeding from the snapshot.
  const { data: entry } = useOrgFsStat(volume, path);
  const ownMode: ShareMode = entry?.shareMode ?? shareMode;
  const effective = entry?.effectivePublic ?? effectivePublic;
  const inherited = effective && ownMode === "private";
  const isDir = kind === "dir";
  const subject = isDir ? "folder" : "file";

  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  const apply = (mode: ShareMode, pw?: string) => {
    setShareMode.mutate(
      { path, mode, password: pw },
      {
        onSuccess: () => {
          setShowPassword(false);
          setPassword("");
          toast.success(
            mode === "private"
              ? t("library.fileShareButton.toastOrgOnly", { subject })
              : mode === "public"
                ? t("library.fileShareButton.toastPublic", { subject })
                : t("library.fileShareButton.toastPassword", { subject }),
          );
        },
        onError: (err) =>
          toast.error(
            err instanceof Error
              ? err.message
              : t("library.fileShareButton.failedUpdateSharing"),
          ),
      },
    );
  };

  // Password mode reveals the field and applies on submit; the others apply at
  // once.
  const selectMode = (mode: ShareMode) => {
    if (mode === "password") {
      setShowPassword(true);
      return;
    }
    setShowPassword(false);
    apply(mode);
  };

  const activeMode: ShareMode = showPassword ? "password" : ownMode;

  const handleCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success(t("library.fileShareButton.linkCopied"));
    setTimeout(() => setCopied(false), 2000);
  };

  const copyRow = url ? (
    <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {url}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={handleCopy}
        aria-label={t("library.fileShareButton.copyLink")}
      >
        {copied ? (
          <Check size={12} className="text-success" />
        ) : (
          <Copy01 size={12} />
        )}
      </Button>
    </div>
  ) : null;

  // Inherited from a published parent folder: read-only here. The mode control
  // is hidden because the parent governs the read — setting this node to "Org
  // only" wouldn't actually restrict it (the parent still serves it), so the
  // owner manages sharing on the parent, not here.
  if (inherited) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Globe01 size={16} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-foreground">
              {t("library.fileShareButton.sharedViaParent")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("library.fileShareButton.inheritedDescription", {
                target: isDir ? "files in this folder" : "this file",
              })}
            </span>
          </div>
        </div>
        {copyRow}
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {MODES.map(({ mode, labelKey, Icon }) => (
          <button
            key={mode}
            type="button"
            disabled={setShareMode.isPending}
            onClick={() => selectMode(mode)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md px-2 py-2 text-xs font-medium transition-colors disabled:opacity-60",
              activeMode === mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={15} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {activeMode === "private"
          ? t("library.fileShareButton.privateDescription", {
              target: isDir ? "these files" : "this link",
            })
          : activeMode === "public"
            ? isDir
              ? t("library.fileShareButton.publicFolderDescription")
              : t("library.fileShareButton.publicFileDescription")
            : t("library.fileShareButton.passwordDescription", {
                target: isDir ? "files in this folder" : "this file",
              })}
      </p>

      {activeMode === "password" && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) apply("password", password);
          }}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t(
              ownMode === "password"
                ? "library.fileShareButton.newPasswordPlaceholder"
                : "library.fileShareButton.passwordPlaceholder",
            )}
            autoComplete="new-password"
            className="h-8 text-xs"
          />
          <Button
            type="submit"
            size="sm"
            className="shrink-0"
            disabled={!password || setShareMode.isPending}
          >
            {ownMode === "password"
              ? t("library.fileShareButton.buttonUpdate")
              : t("library.fileShareButton.buttonSet")}
          </Button>
        </form>
      )}

      {copyRow}
    </div>
  );
}

/** Preview-toolbar popover trigger (files). */
export function FileShareButton({
  volume,
  path,
  shareMode,
  effectivePublic,
  url,
}: {
  volume: string;
  path: string;
  shareMode: ShareMode;
  effectivePublic: boolean;
  url: string;
}) {
  const t = useT();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("library.fileShareButton.share")}
            >
              <Share07 size={14} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("library.fileShareButton.share")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <ShareControls
          volume={volume}
          path={path}
          kind="file"
          shareMode={shareMode}
          effectivePublic={effectivePublic}
          url={url}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Modal share surface opened from Library cards (files and folders). */
export function ShareDialog({
  target,
  onOpenChange,
}: {
  target: ShareTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("library.fileShareButton.shareDialogTitle", {
              type: target?.kind === "dir" ? "folder" : "file",
            })}
          </DialogTitle>
        </DialogHeader>
        {target && <ShareControls {...target} />}
      </DialogContent>
    </Dialog>
  );
}
