/**
 * Link the agent's system prompt to an org-fs (Library) file.
 *
 * Unlinked: a "Link file" dropdown listing recent markdown/text files, with a
 * search that also spans the readonly `public-*` volumes (git-synced sets).
 * Linked: a chip with the file name, a lock when the volume is readonly, and
 * an unlink button. The editor itself stays in the parent — this component
 * only picks/clears `metadata.instructionsFile`.
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Lock01, Paperclip, SearchMd, XClose } from "@untitledui/icons";
import { useState } from "react";
import { FileTypeIcon } from "@/web/components/file-type-icon.tsx";
import {
  type OrgFsRecentEntry,
  useOrgFsRecent,
  useOrgFsSearch,
} from "@/web/hooks/use-org-fs.ts";
import { basename } from "@/web/layouts/library/location";

/** Files that make sense as a prompt source. */
const PROMPT_FILE_RE = /\.(md|mdx|markdown|txt|text)$/i;

export interface PromptFileRef {
  volume: string;
  path: string;
}

export function PromptFileLink({
  file,
  readOnly,
  onLink,
  onUnlink,
}: {
  file: PromptFileRef | null;
  readOnly: boolean;
  onLink: (file: PromptFileRef) => void;
  onUnlink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Recent covers the org's own volumes; search also spans the readonly
  // public sets — so typing is how git-synced files get found.
  const { data: recent = [] } = useOrgFsRecent(60, { enabled: open });
  const { data: searched = [] } = useOrgFsSearch(search.trim());

  if (file) {
    return (
      <div
        className="flex h-8 items-center gap-1.5 rounded-md border bg-muted/50 pl-2 pr-1 text-xs text-muted-foreground"
        title={
          readOnly
            ? `${file.volume}/${file.path} — read-only (synced volume)`
            : `${file.volume}/${file.path}`
        }
      >
        <FileTypeIcon
          filename={basename(file.path)}
          className="h-4 w-3.5 shrink-0"
        />
        <span className="max-w-40 truncate">{basename(file.path)}</span>
        {readOnly && <Lock01 size={12} className="shrink-0" />}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onUnlink}
          aria-label="Unlink prompt file"
        >
          <XClose size={12} />
        </Button>
      </div>
    );
  }

  const pool: OrgFsRecentEntry[] = search.trim() ? searched : recent;
  const candidates = pool
    .filter((e) => e.kind !== "dir" && PROMPT_FILE_RE.test(e.path))
    .slice(0, 8);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Paperclip size={13} />
          Link file
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <SearchMd size={16} className="shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search markdown/text files..."
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {candidates.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              No markdown or text files found.
            </p>
          ) : (
            candidates.map((entry) => (
              <DropdownMenuItem
                key={`${entry.volume}/${entry.path}`}
                onSelect={() => {
                  setOpen(false);
                  onLink({ volume: entry.volume, path: entry.path });
                }}
              >
                <FileTypeIcon
                  filename={basename(entry.path)}
                  className="h-5 w-4 shrink-0"
                />
                <span className="flex-1 truncate">{basename(entry.path)}</span>
                <span className="max-w-24 truncate text-xs text-muted-foreground">
                  {entry.volume}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
