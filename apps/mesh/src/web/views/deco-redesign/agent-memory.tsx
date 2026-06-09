/**
 * Agent memory (mock)
 *
 * Memory is a small repo of markdown, like skills:
 *
 *   memory/
 *   ├── MEMORY.md          # concise index, loaded into every session
 *   ├── goals.md           # one topic note per file
 *   ├── cms-workflow.md
 *   └── ...
 *
 * This page shows the index (openable, read it) plus a table of the topic
 * notes (each openable). Agent-aware via `?agent`. Mock only.
 */

import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { BookOpen01, File02, XClose } from "@untitledui/icons";
import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { resolveAgent } from "./agent-data";

interface MemoryFile {
  name: string;
  summary: string;
  updated: string;
  content: string;
}

const INDEX: MemoryFile = {
  name: "MEMORY.md",
  summary: "Concise index — loaded into every session",
  updated: "today",
  content: `# Memory index

- [goals.md](goals.md) — conversion target 2.4%, grow organic traffic
- [cms-workflow.md](cms-workflow.md) — banner copy comes from Trello
- [blockers.md](blockers.md) — Bazaarvoice API key expired Thursday
- [preferences.md](preferences.md) — one morning briefing; propose, then act
- [brand-voice.md](brand-voice.md) — direct, numbers-first, no hype`,
};

const NOTES: MemoryFile[] = [
  {
    name: "goals.md",
    summary: "Conversion and traffic targets",
    updated: "2 days ago",
    content: `# Goals

- Conversion target is 2.4% (currently 2.1%).
- Grow organic traffic — the owner's standing focus.
- Keep the error rate near zero.`,
  },
  {
    name: "cms-workflow.md",
    summary: "Where banner copy comes from",
    updated: "5 days ago",
    content: `# CMS workflow

Banner copy comes from Trello, not written in the CMS. Pull the latest card
before scheduling a campaign.`,
  },
  {
    name: "blockers.md",
    summary: "Open access and credential gaps",
    updated: "Thursday",
    content: `# Blockers

- Bazaarvoice API key expired Thursday — need a new one to resume reviews.
- No write access to the checkout repo yet.`,
  },
  {
    name: "preferences.md",
    summary: "How the owner likes to work",
    updated: "1 week ago",
    content: `# Preferences

- One briefing per morning, not a stream of pings.
- Propose changes, then act on approval.
- Escalate urgent issues over WhatsApp.`,
  },
  {
    name: "brand-voice.md",
    summary: "Tone and wording rules",
    updated: "2 weeks ago",
    content: `# Brand voice

Direct, concrete, numbers-first. Sentence case. No hype, no exclamation marks.`,
  },
];

function MemoryFileModal({
  file,
  onClose,
}: {
  file: MemoryFile;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeButtonClassName="hidden"
        className="flex h-[70vh] w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <File02 size={16} className="shrink-0 text-muted-foreground" />
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
            {file.name}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onClose}
            aria-label="Close"
          >
            <XClose size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
            {file.content}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentMemory() {
  const { agent } = useSearch({ from: "/shell/$org/settings/agent/memory" });
  const { org: organization } = useProjectContext();
  const profile = resolveAgent(agent, {
    name: organization.name,
    logo: organization.logo,
  });
  const [openFile, setOpenFile] = useState<MemoryFile | null>(null);

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div>
              <h1 className="text-xl font-medium text-foreground">Memory</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                What {profile.name} remembers about you and the work. It updates
                this as you work together.
              </p>
            </div>

            {/* Index — loaded into every session */}
            <SettingsSection title="Index">
              <SettingsCard>
                <button
                  type="button"
                  onClick={() => setOpenFile(INDEX)}
                  className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                    <BookOpen01 size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <code className="block truncate font-mono text-sm font-medium text-foreground">
                      {INDEX.name}
                    </code>
                    <span className="block truncate text-xs text-muted-foreground">
                      {INDEX.summary}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Always loaded
                  </span>
                </button>
              </SettingsCard>
            </SettingsSection>

            {/* Notes — one topic file each */}
            <SettingsSection title="Notes">
              <SettingsCard>
                {NOTES.map((note) => (
                  <button
                    key={note.name}
                    type="button"
                    onClick={() => setOpenFile(note)}
                    className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                      <File02 size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <code className="block truncate font-mono text-sm font-medium text-foreground">
                        {note.name}
                      </code>
                      <span className="block truncate text-xs text-muted-foreground">
                        {note.summary}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {note.updated}
                    </span>
                  </button>
                ))}
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>

      {openFile && (
        <MemoryFileModal file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </Page>
  );
}
