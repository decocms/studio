/**
 * Settings → Memory — what the org's agents remember across tasks.
 *
 * MOCK: the entries below are sample data. The server keeps memory per run
 * (`apps/api/src/api/routes/decopilot/memory.ts`) and exposes no org-level
 * read/write yet, so nothing here persists. The notice on the page says so —
 * a settings screen that silently forgets is worse than no screen.
 */

import { useState } from "react";
import { Database01, Plus, SearchSm, Trash03 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Page } from "@/components/page";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { timeAgo } from "@/layouts/library/cards";
import { useT } from "@/i18n/use-t.ts";

interface MemoryEntry {
  id: string;
  body: string;
  /** Who wrote it: an agent session, or a person. */
  source: string;
  writtenAt: string;
}

/** Sample data. See the file header: nothing here is persisted. */
const SAMPLE_MEMORIES: MemoryEntry[] = [
  {
    id: "m1",
    body: "Storefront PDP changes always need a Playwright before/after screenshot on the card.",
    source: "DECO-12",
    writtenAt: "2026-08-18T14:20:00Z",
  },
  {
    id: "m2",
    body: "This org uses design system tokens only. Raw palette classes get reverted in review.",
    source: "Code reviewer",
    writtenAt: "2026-08-15T09:05:00Z",
  },
  {
    id: "m3",
    body: "Publishing to production is gated on the QA agent approving first.",
    source: "DECO-07",
    writtenAt: "2026-08-11T17:42:00Z",
  },
];

export function OrgMemoryPage() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState(SAMPLE_MEMORIES);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? memories.filter(
        (memory) =>
          memory.body.toLowerCase().includes(needle) ||
          memory.source.toLowerCase().includes(needle),
      )
    : memories;

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <SettingsSection
              title={t("settings.memory.title")}
              description={t("settings.memory.description")}
              actions={
                <Button size="sm" disabled>
                  <Plus size={16} />
                  {t("settings.memory.add")}
                </Button>
              }
            >
              <p className="px-4 text-xs text-muted-foreground">
                {t("settings.memory.mockNotice")}
              </p>
              <div className="relative px-4">
                <SearchSm
                  size={16}
                  className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder={t("settings.memory.searchPlaceholder")}
                  className="pl-9"
                />
              </div>
              <SettingsCard>
                {memories.length === 0 ? (
                  <SettingsCardItem
                    title={t("settings.memory.emptyTitle")}
                    description={t("settings.memory.emptyDescription")}
                  />
                ) : visible.length === 0 ? (
                  <SettingsCardItem title={t("settings.memory.noMatches")} />
                ) : (
                  visible.map((memory) => (
                    <SettingsCardItem
                      key={memory.id}
                      icon={<Database01 size={16} />}
                      title={memory.body}
                      description={`${t("settings.memory.writtenBy", {
                        source: memory.source,
                      })} · ${timeAgo(memory.writtenAt)}`}
                      action={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("settings.memory.remove")}
                          onClick={() =>
                            setMemories((prev) =>
                              prev.filter((m) => m.id !== memory.id),
                            )
                          }
                        >
                          <Trash03 size={16} />
                        </Button>
                      }
                    />
                  ))
                )}
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
