/**
 * Default Home Agents Form
 *
 * Org-wide config for which agents appear on the home view.
 * Stored in `organization_settings.default_home_agents` as { ids: string[] }.
 *
 * IDs are either WELL_KNOWN_AGENT_TEMPLATES ids ("site-editor", "ai-image", …)
 * or custom virtual MCP ids (UUIDs). The home view resolves both at render time.
 *
 * When the org has never configured this, the form pre-fills with
 * `DEFAULT_HOME_AGENT_IDS` so admins start from today's defaults.
 */

import { Suspense, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  isDecopilot,
  WELL_KNOWN_AGENT_TEMPLATES,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { CollectionSearch } from "@deco/ui/components/collection-search.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Plus, RefreshCw01, Menu02, X, Users03 } from "@untitledui/icons";
import { toast } from "sonner";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  SettingsCard,
  SettingsCardActions,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  useDefaultHomeAgents,
  useUpdateDefaultHomeAgents,
} from "@/web/hooks/use-organization-settings";
import { track } from "@/web/lib/posthog-client";

/**
 * IDs that appear in the home view today before any admin config exists.
 * Order matches what the home view currently renders.
 */
const DEFAULT_HOME_AGENT_IDS: readonly string[] = [
  "site-editor",
  "site-diagnostics",
  "ai-image",
  "ai-research",
];

/**
 * Visible cap on the home view. The admin can add more, but only the first
 * HOME_VIEW_DISPLAY_LIMIT will be rendered.
 */
const HOME_VIEW_DISPLAY_LIMIT = 8;

interface ResolvedAgent {
  id: string;
  title: string;
  icon: string | null | undefined;
  kind: "template" | "custom" | "missing";
}

function resolveAgent(
  id: string,
  templates: typeof WELL_KNOWN_AGENT_TEMPLATES,
  customAgents: ReadonlyArray<{
    id: string | null;
    title: string;
    icon?: string | null;
  }>,
): ResolvedAgent {
  const template = templates.find((t) => t.id === id);
  if (template) {
    return {
      id: template.id,
      title: template.title,
      icon: template.icon,
      kind: "template",
    };
  }
  const custom = customAgents.find((a) => a.id === id);
  if (custom) {
    return {
      id,
      title: custom.title,
      icon: custom.icon ?? null,
      kind: "custom",
    };
  }
  return { id, title: id, icon: null, kind: "missing" };
}

function SortableAgentRow({
  agent,
  onRemove,
}: {
  agent: ResolvedAgent;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-background",
        isDragging && "shadow-lg",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
        aria-label={`Drag to reorder ${agent.title}`}
      >
        <Menu02 size={14} />
      </button>
      <IntegrationIcon
        icon={agent.icon}
        name={agent.title}
        size="xs"
        fallbackIcon={<Users03 size={14} />}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm text-foreground truncate">{agent.title}</span>
        <span className="text-xs text-muted-foreground">
          {agent.kind === "template"
            ? "Template"
            : agent.kind === "custom"
              ? "Custom agent"
              : "Unavailable"}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground p-1 rounded"
        aria-label={`Remove ${agent.title}`}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function AddAgentPopover({
  selectedIds,
  onAdd,
}: {
  selectedIds: string[];
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const customAgents = useVirtualMCPs();

  const selectedSet = new Set(selectedIds);
  const lowerSearch = search.toLowerCase();

  const availableTemplates = WELL_KNOWN_AGENT_TEMPLATES.filter(
    (t) =>
      !selectedSet.has(t.id) &&
      (!search || t.title.toLowerCase().includes(lowerSearch)),
  );

  const availableCustom = customAgents
    .filter(
      (a): a is typeof a & { id: string } =>
        a.id !== null && !isDecopilot(a.id) && !selectedSet.has(a.id),
    )
    .filter((a) => !search || a.title.toLowerCase().includes(lowerSearch));

  const handlePick = (id: string) => {
    onAdd(id);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus size={14} />
          Add agent
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0 overflow-hidden" align="start">
        <CollectionSearch
          value={search}
          onChange={setSearch}
          placeholder="Search agents..."
        />
        <div className="max-h-[320px] overflow-y-auto p-2 flex flex-col gap-3">
          {availableTemplates.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Templates
              </span>
              {availableTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handlePick(t.id)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent text-left"
                >
                  <IntegrationIcon icon={t.icon} name={t.title} size="xs" />
                  <span className="text-sm truncate">{t.title}</span>
                </button>
              ))}
            </div>
          )}
          {availableCustom.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Custom agents
              </span>
              {availableCustom.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => handlePick(a.id)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent text-left"
                >
                  <IntegrationIcon
                    icon={a.icon}
                    name={a.title}
                    size="xs"
                    fallbackIcon={<Users03 size={14} />}
                  />
                  <span className="text-sm truncate">{a.title}</span>
                </button>
              ))}
            </div>
          )}
          {availableTemplates.length === 0 && availableCustom.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">
              {search ? "No agents found" : "All agents are already added"}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DefaultHomeAgentsFormContent() {
  const saved = useDefaultHomeAgents();
  const customAgents = useVirtualMCPs();
  const updateMutation = useUpdateDefaultHomeAgents();

  const initialIds = saved?.ids ?? [...DEFAULT_HOME_AGENT_IDS];
  const [draftIds, setDraftIds] = useState<string[]>(initialIds);

  const isDirty =
    draftIds.length !== initialIds.length ||
    draftIds.some((id, i) => id !== initialIds[i]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = draftIds.indexOf(active.id as string);
    const newIndex = draftIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    setDraftIds(arrayMove([...draftIds], oldIndex, newIndex));
  };

  const handleAdd = (id: string) => {
    if (draftIds.includes(id)) return;
    setDraftIds([...draftIds, id]);
  };

  const handleRemove = (id: string) => {
    setDraftIds(draftIds.filter((existing) => existing !== id));
  };

  const handleResetDefaults = () => {
    setDraftIds([...DEFAULT_HOME_AGENT_IDS]);
  };

  const handleSave = () => {
    updateMutation.mutate(
      { ids: draftIds },
      {
        onSuccess: () => {
          track("default_home_agents_updated", {
            count: draftIds.length,
            template_count: draftIds.filter((id) =>
              WELL_KNOWN_AGENT_TEMPLATES.some((t) => t.id === id),
            ).length,
          });
          toast.success("Default home agents updated");
        },
        onError: (error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to update default home agents",
          );
        },
      },
    );
  };

  const resolvedDraft = draftIds.map((id) =>
    resolveAgent(id, WELL_KNOWN_AGENT_TEMPLATES, customAgents),
  );

  const overflowCount = Math.max(0, draftIds.length - HOME_VIEW_DISPLAY_LIMIT);

  return (
    <SettingsSection
      title="Default home agents"
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleResetDefaults}
          disabled={updateMutation.isPending}
        >
          <RefreshCw01 size={14} />
          Reset defaults
        </Button>
      }
    >
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-3">
          {resolvedDraft.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No agents selected. The home view will only show "Create agent".
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={draftIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-1.5">
                  {resolvedDraft.map((agent, i) => (
                    <div key={agent.id} className="flex flex-col gap-1.5">
                      {i === HOME_VIEW_DISPLAY_LIMIT && (
                        <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
                          <div className="flex-1 h-px bg-border" />
                          <span>
                            Below this line is hidden on the home view
                          </span>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                      )}
                      <SortableAgentRow
                        agent={agent}
                        onRemove={() => handleRemove(agent.id)}
                      />
                    </div>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          <div className="flex items-center justify-between">
            <AddAgentPopover selectedIds={draftIds} onAdd={handleAdd} />
            {overflowCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {overflowCount} agent{overflowCount === 1 ? "" : "s"} won&apos;t
                fit on the home view
              </span>
            )}
          </div>
        </div>
        {isDirty && (
          <SettingsCardActions>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraftIds(initialIds)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </SettingsCardActions>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function DefaultHomeAgentsFormSkeleton() {
  return (
    <SettingsSection title="Default home agents">
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

export function DefaultHomeAgentsForm() {
  return (
    <Suspense fallback={<DefaultHomeAgentsFormSkeleton />}>
      <DefaultHomeAgentsFormContent />
    </Suspense>
  );
}
