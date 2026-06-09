/**
 * Agent files (mock)
 *
 * The agent's documents — both what it reads (knowledge you give it) and what
 * it produces (reports, generated changes). This merges the old "Files" and
 * "Artifacts": same surface, two directions. Mock only.
 */

import { File02, FilePlus02, UploadCloud01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";

interface AgentFile {
  name: string;
  meta: string;
}

const KNOWLEDGE: AgentFile[] = [
  { name: "Brand guidelines.pdf", meta: "2.4 MB · uploaded May 12" },
  { name: "Tone of voice.md", meta: "8 KB · uploaded May 12" },
  { name: "Product catalog feed.csv", meta: "1.1 MB · synced daily" },
  { name: "2026 campaign calendar.xlsx", meta: "320 KB · uploaded Jun 2" },
];

const PRODUCED: AgentFile[] = [
  { name: "2026-06-08 traffic report.md", meta: "Generated Jun 8" },
  { name: "PR #3302 summary.md", meta: "Generated Jun 7" },
  { name: "alt-text batch.csv", meta: "84 rows · generated Jun 6" },
];

function FileRow({ file }: { file: AgentFile }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        <File02 size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {file.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {file.meta}
        </span>
      </span>
    </div>
  );
}

export function AgentFiles() {
  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-medium text-foreground">Files</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Documents the agent reads, and the files it produces.
                </p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0">
                <UploadCloud01 size={14} />
                Upload
              </Button>
            </div>

            <SettingsSection title="Knowledge — files the agent reads">
              <SettingsCard>
                {KNOWLEDGE.map((f) => (
                  <FileRow key={f.name} file={f} />
                ))}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Produced by the agent">
              {PRODUCED.length > 0 ? (
                <SettingsCard>
                  {PRODUCED.map((f) => (
                    <FileRow key={f.name} file={f} />
                  ))}
                </SettingsCard>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                  <FilePlus02 size={16} className="shrink-0" />
                  Nothing produced yet.
                </div>
              )}
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
