/**
 * The site's specialists, and what each of them was told.
 *
 * These instructions were constants in the product's source until now, which
 * made "write in our voice, not that one" a deploy. Here they are a textarea,
 * and the roles are the ones a run delegates to — the same files, not a copy
 * of them.
 *
 * The contract above the editor is read-only and deliberately visible. It is
 * composed over the body at run time and is not in the file, so no edit can
 * remove it; showing it is what stops someone writing around a rule they
 * cannot see.
 */

import { useState } from "react";
import {
  type AgentDefinition,
  AGENT_CONTRACT,
} from "@decocms/shared/harness/agent-md";
import { Lock01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { SaveStatus } from "./save-status";
import { useProjectAgents } from "./use-project-agents";

interface ProjectRef {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

export function AgentsPanel({ project }: { project: ProjectRef | undefined }) {
  const t = useT();
  const roster = useProjectAgents(project);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [contractOpen, setContractOpen] = useState(false);
  /** The unsaved body, by slug. Absent means "what the file says". */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const selected =
    roster.agents.find((agent) => agent.slug === openSlug) ?? roster.agents[0];
  const draft = selected ? (drafts[selected.slug] ?? selected.body) : "";
  const dirty = !!selected && draft !== selected.body;

  const save = (definition: AgentDefinition) => {
    roster.save({ ...definition, body: draft });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[definition.slug];
      return next;
    });
  };

  if (!roster.isLoading && roster.agents.length === 0) {
    return (
      <div className="px-8 py-6">
        <EmptyState
          title={t("sandbox.blogAgents.emptyTitle")}
          description={t("sandbox.blogAgents.emptyBody")}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-6 px-8 py-6">
      <nav className="w-56 shrink-0 space-y-1">
        {roster.agents.map((agent) => (
          <button
            type="button"
            key={agent.slug}
            onClick={() => setOpenSlug(agent.slug)}
            className={cn(
              "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
              agent.slug === selected?.slug
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            <span className="block truncate">{agent.name}</span>
            {agent.description && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {agent.description}
              </span>
            )}
          </button>
        ))}
      </nav>

      {selected && (
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{selected.name}</h3>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogAgents.beltLabel")}:{" "}
                {selected.tools?.join(", ") ||
                  t("sandbox.blogAgents.beltEverything")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <SaveStatus
                isPending={roster.isSaving}
                isError={roster.isError}
              />
              <Button
                size="sm"
                disabled={!dirty || roster.isSaving}
                onClick={() => save(selected)}
              >
                {t("sandbox.blogAgents.save")}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Lock01 size={12} className="shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium">
                {t("sandbox.blogAgents.contractTitle")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sandbox.blogAgents.contractHint")}
            </p>
            <pre
              className={cn(
                "mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground",
                !contractOpen && "line-clamp-3",
              )}
            >
              {AGENT_CONTRACT}
            </pre>
            <button
              type="button"
              onClick={() => setContractOpen((open) => !open)}
              className="mt-1.5 text-xs font-medium text-muted-foreground underline underline-offset-2"
            >
              {t(
                contractOpen
                  ? "sandbox.blogAgents.contractLess"
                  : "sandbox.blogAgents.contractMore",
              )}
            </button>
          </div>

          {/* The divider `agentInstructions` writes between the two halves. */}
          <div className="text-center text-xs text-muted-foreground/60">—</div>

          <Textarea
            value={draft}
            onChange={(e) =>
              setDrafts((prev) => ({
                ...prev,
                [selected.slug]: e.target.value,
              }))
            }
            rows={22}
            className="font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}
