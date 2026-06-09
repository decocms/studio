/**
 * Agent personalization (mock) — the editable user layer
 *
 * Your personal layer on top of a managed agent: guidance, your own skills,
 * and the connections you authorize. Agent-aware via `?agent`. Mock only.
 */

import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Code02, Plus, Stars01, XClose } from "@untitledui/icons";
import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { Page } from "@/web/components/page";
import {
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { resolveAgent, type AgentSkill } from "./agent-data";

function SkillModal({
  skill,
  onClose,
}: {
  skill: AgentSkill;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeButtonClassName="hidden"
        className="flex h-[70vh] w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              skill.tile,
            )}
          >
            {skill.icon}
          </span>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {skill.name}
          </h2>
          <Button variant="outline" size="sm">
            Remove
          </Button>
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
        <div className="flex min-h-0 flex-1">
          <aside className="w-48 shrink-0 border-r border-border p-3">
            <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground/60">
              Files
            </p>
            <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
              <Code02 size={13} className="shrink-0 opacity-60" />
              SKILL.MD
            </div>
          </aside>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <p className="text-xs font-medium text-muted-foreground">
              Description
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {skill.description}
            </p>
            <div className="mt-5 border-t border-border pt-5">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                {skill.content}
              </pre>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentPersonalization() {
  const { org } = useParams({ from: "/shell/$org" });
  const { agent } = useSearch({
    from: "/shell/$org/settings/agent/personalization",
  });
  const { org: organization } = useProjectContext();
  const profile = resolveAgent(agent, {
    name: organization.name,
    logo: organization.logo,
  });

  const [guidance, setGuidance] = useState("");
  const [openSkill, setOpenSkill] = useState<AgentSkill | null>(null);

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div>
              <Link
                to="/$org/settings/agent"
                params={{ org }}
                search={{ agent }}
                className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft size={14} />
                {profile.name}
              </Link>
              <h1 className="text-xl font-medium text-foreground">
                Agent personalization
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your personal layer on top of {profile.name}.
              </p>
            </div>

            <SettingsSection
              title="Guidance"
              description={`Personal instructions and context for ${profile.name}.`}
              actions={
                <Button variant="outline" size="sm">
                  <Stars01 size={13} />
                  Improve
                </Button>
              }
            >
              <Textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="Add instructions on top of the base prompt — tone, priorities, things to always or never do..."
                className="min-h-[140px] resize-none rounded-xl bg-card px-4 py-3 text-sm leading-relaxed"
              />
            </SettingsSection>

            <SettingsSection
              title="Skills"
              description="Reusable prompts auto-selected by the agent or invoked via slash commands."
              actions={
                <Button variant="outline" size="sm">
                  <Plus size={14} />
                  Add skill
                </Button>
              }
            >
              <div className="flex flex-col gap-2">
                {profile.skills.length > 0 ? (
                  profile.skills.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setOpenSkill(s)}
                      className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <span
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-lg",
                          s.tile,
                        )}
                      >
                        {s.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {s.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.description}
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground/75">
                      <Plus size={16} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      No skills yet. Add one of your own.
                    </span>
                  </button>
                )}
              </div>
            </SettingsSection>

            <SettingsSection
              title="Connections"
              description="Apps this agent uses. Connect your accounts to authorize them."
            >
              <div className="flex flex-col gap-2">
                {profile.connections.map((c) => (
                  <Link
                    key={c.id}
                    to="/$org/settings/connections"
                    params={{ org }}
                    className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <IntegrationIcon icon={c.icon} name={c.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {c.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.description}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>

      {openSkill && (
        <SkillModal skill={openSkill} onClose={() => setOpenSkill(null)} />
      )}
    </Page>
  );
}
