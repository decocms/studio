import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Page } from "@/web/components/page";
import {
  ModelSelector,
  type ModelChangePayload,
  type SelectedModelState,
} from "@/web/components/chat/select-model.tsx";
import { ToolSetSelector } from "@/web/components/tool-set-selector.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronRight, Plus, Trash01 } from "@untitledui/icons";
import { useState } from "react";
import { formatTimeAgo } from "@/web/lib/format-time";

// ============================================================================
// Types
// ============================================================================

interface Trigger {
  id: string;
  label: string;
}

interface AutomationTool {
  id: string;
  connectionId: string;
  connectionIcon: string | null;
  connectionName: string;
  toolName: string;
}

interface RunHistoryEntry {
  id: string;
  startedAt: Date;
  status: "success" | "failed";
  durationMs: number;
}

// ============================================================================
// Mock data
// ============================================================================

const MOCK_TOOLS: AutomationTool[] = [
  {
    id: "t1",
    connectionId: "conn-github",
    connectionIcon: null,
    connectionName: "GitHub",
    toolName: "Open Pull Request",
  },
];

const MOCK_RUN_HISTORY: RunHistoryEntry[] = [
  {
    id: "r1",
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    status: "success",
    durationMs: 3200,
  },
  {
    id: "r2",
    startedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
    status: "failed",
    durationMs: 800,
  },
];

// ============================================================================
// Available trigger items
// ============================================================================

const TRIGGER_OPTIONS = [
  { id: "every", label: "Every...", group: "Scheduled" },
  { id: "custom-cron", label: "Custom (cron)", group: "Scheduled" },
];

// ============================================================================
// TriggersSection
// ============================================================================

interface TriggersSectionProps {
  triggers: Trigger[];
  onTriggersChange: (triggers: Trigger[]) => void;
}

function TriggersSection({ triggers, onTriggersChange }: TriggersSectionProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = TRIGGER_OPTIONS.filter((opt) =>
    opt.label.toLowerCase().includes(search.toLowerCase()),
  );

  const groupedFiltered = filtered.reduce<
    Record<string, typeof TRIGGER_OPTIONS>
  >((acc, opt) => {
    (acc[opt.group] ??= []).push(opt);
    return acc;
  }, {});

  const handleAddTrigger = (opt: (typeof TRIGGER_OPTIONS)[number]) => {
    onTriggersChange([
      ...triggers,
      { id: `${opt.id}-${Date.now()}`, label: opt.label },
    ]);
    setPopoverOpen(false);
    setSearch("");
  };

  const handleRemoveTrigger = (id: string) => {
    onTriggersChange(triggers.filter((t) => t.id !== id));
  };

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">Triggers</span>
      <div className="rounded-lg border border-border divide-y divide-border">
        {triggers.map((trigger) => (
          <div
            key={trigger.id}
            className="flex items-center justify-between px-3 py-2"
          >
            <span className="text-sm">{trigger.label}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => handleRemoveTrigger(trigger.id)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
        ))}
        <div className="px-3 py-2">
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-muted-foreground hover:text-foreground px-0"
              >
                <Plus size={14} />
                Add Trigger
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
              <div className="p-2 border-b border-border">
                <input
                  autoFocus
                  className="w-full text-sm outline-none bg-transparent placeholder:text-muted-foreground"
                  placeholder="Search triggers..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="p-1">
                {Object.entries(groupedFiltered).map(([group, opts]) => (
                  <div key={group}>
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      {group}
                    </div>
                    {opts.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="w-full flex items-center justify-between px-2 py-1.5 text-sm rounded-md hover:bg-accent cursor-pointer"
                        onClick={() => handleAddTrigger(opt)}
                      >
                        <span>{opt.label}</span>
                        <ChevronRight
                          size={14}
                          className="text-muted-foreground"
                        />
                      </button>
                    ))}
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                    No triggers found
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// InstructionsSection
// ============================================================================

interface InstructionsSectionProps {
  instructions: string;
  onInstructionsChange: (value: string) => void;
  selectedModel: SelectedModelState | undefined;
  onModelChange: (payload: ModelChangePayload) => void;
}

function InstructionsSection({
  instructions,
  onInstructionsChange,
  selectedModel,
  onModelChange,
}: InstructionsSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">Instructions</span>
      <div className="rounded-lg border border-border overflow-hidden">
        <Textarea
          className="border-none shadow-none focus-visible:ring-0 resize-none min-h-[120px] rounded-none"
          placeholder="Describe what this automation should do..."
          value={instructions}
          onChange={(e) => onInstructionsChange(e.target.value)}
        />
        <div className="border-t border-border px-3 py-1.5 flex items-center">
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            variant="borderless"
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ToolsSection
// ============================================================================

interface ToolsSectionProps {
  tools: AutomationTool[];
  onRemoveTool: (id: string) => void;
  onAddToolClick: () => void;
}

function ToolsSection({
  tools,
  onRemoveTool,
  onAddToolClick,
}: ToolsSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">Tools</span>
      <div className="rounded-lg border border-border divide-y divide-border">
        {tools.map((tool) => (
          <div key={tool.id} className="flex items-center gap-3 px-3 py-2">
            <IntegrationIcon
              icon={tool.connectionIcon}
              name={tool.connectionName}
              size="xs"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm">{tool.toolName}</span>
              <span className="text-xs text-muted-foreground ml-2">
                {tool.connectionName}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => onRemoveTool(tool.id)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
        ))}
        <div className="px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-muted-foreground hover:text-foreground px-0"
            onClick={onAddToolClick}
          >
            <Plus size={14} />
            Add Tool
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SettingsTab
// ============================================================================

interface SettingsTabProps {
  triggers: Trigger[];
  onTriggersChange: (triggers: Trigger[]) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  selectedModel: SelectedModelState | undefined;
  onModelChange: (payload: ModelChangePayload) => void;
  tools: AutomationTool[];
  onRemoveTool: (id: string) => void;
  onAddToolClick: () => void;
}

function SettingsTab({
  triggers,
  onTriggersChange,
  instructions,
  onInstructionsChange,
  selectedModel,
  onModelChange,
  tools,
  onRemoveTool,
  onAddToolClick,
}: SettingsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <TriggersSection
        triggers={triggers}
        onTriggersChange={onTriggersChange}
      />
      <InstructionsSection
        instructions={instructions}
        onInstructionsChange={onInstructionsChange}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
      />
      <ToolsSection
        tools={tools}
        onRemoveTool={onRemoveTool}
        onAddToolClick={onAddToolClick}
      />
    </div>
  );
}

// ============================================================================
// RunHistoryTab
// ============================================================================

interface RunHistoryTabProps {
  entries: RunHistoryEntry[];
}

function RunHistoryTab({ entries }: RunHistoryTabProps) {
  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        No runs yet
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border divide-y divide-border">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-3 px-3 py-2">
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
              entry.status === "success"
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
            )}
          >
            {entry.status === "success" ? "Success" : "Failed"}
          </span>
          <span className="text-sm flex-1">
            {formatTimeAgo(entry.startedAt)}
          </span>
          <span className="text-sm text-muted-foreground">
            {(entry.durationMs / 1000).toFixed(1)}s
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// AutomationDetail — main export
// ============================================================================

const TABS = [
  { id: "settings", label: "Settings" },
  { id: "run-history", label: "Run History" },
];

export default function AutomationDetail() {
  const [title, setTitle] = useState("Daily Standup Summary");
  const [active, setActive] = useState(true);
  const [activeTab, setActiveTab] = useState<"settings" | "run-history">(
    "settings",
  );
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [instructions, setInstructions] = useState("");
  const [selectedModel, setSelectedModel] = useState<
    SelectedModelState | undefined
  >(undefined);
  const [tools, setTools] = useState<AutomationTool[]>(MOCK_TOOLS);
  const [toolSheetOpen, setToolSheetOpen] = useState(false);

  const toolSet: Record<string, string[]> = {};
  for (const t of tools) {
    (toolSet[t.connectionId] ??= []).push(t.toolName);
  }

  const handleToolSetChange = (newToolSet: Record<string, string[]>) => {
    const newTools: AutomationTool[] = [];
    for (const [connectionId, toolNames] of Object.entries(newToolSet)) {
      for (const toolName of toolNames) {
        const existing = tools.find(
          (t) => t.connectionId === connectionId && t.toolName === toolName,
        );
        if (existing) {
          newTools.push(existing);
        } else {
          newTools.push({
            id: `${connectionId}-${toolName}-${Date.now()}`,
            connectionId,
            connectionIcon: null,
            connectionName: connectionId,
            toolName,
          });
        }
      }
    }
    setTools(newTools);
    setToolSheetOpen(false);
  };

  const handleRemoveTool = (id: string) => {
    setTools(tools.filter((t) => t.id !== id));
  };

  const handleModelChange = (payload: ModelChangePayload) => {
    setSelectedModel({
      connectionId: payload.connectionId,
      thinking: { id: payload.id },
      fast: { id: payload.id },
    });
  };

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="border-none shadow-none focus-visible:ring-0 text-sm font-medium p-0 h-auto bg-transparent"
          />
        </Page.Header.Left>
        <Page.Header.Right>
          <span
            className={cn(
              "text-sm",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {active ? "Active" : "Inactive"}
          </span>
          <Switch checked={active} onCheckedChange={setActive} />
        </Page.Header.Right>
      </Page.Header>
      <Page.Content>
        <div className="flex flex-col gap-6 p-4 max-w-2xl">
          <CollectionTabs
            tabs={TABS}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as "settings" | "run-history")}
          />
          {activeTab === "settings" && (
            <SettingsTab
              triggers={triggers}
              onTriggersChange={setTriggers}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              tools={tools}
              onRemoveTool={handleRemoveTool}
              onAddToolClick={() => setToolSheetOpen(true)}
            />
          )}
          {activeTab === "run-history" && (
            <RunHistoryTab entries={MOCK_RUN_HISTORY} />
          )}
        </div>
      </Page.Content>
      <Sheet open={toolSheetOpen} onOpenChange={setToolSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl p-0">
          <SheetHeader className="px-4 py-3 border-b border-border">
            <SheetTitle>Select Tools</SheetTitle>
          </SheetHeader>
          <div className="h-[calc(100vh-4rem)] overflow-hidden">
            <ToolSetSelector
              toolSet={toolSet}
              onToolSetChange={handleToolSetChange}
            />
          </div>
        </SheetContent>
      </Sheet>
    </Page>
  );
}
