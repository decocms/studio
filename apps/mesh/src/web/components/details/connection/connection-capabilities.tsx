import { cn } from "@deco/ui/lib/utils.ts";
import { BookOpen01, Columns01, Tool01 } from "@untitledui/icons";
import { useState } from "react";

/**
 * Converts a snake_case or dot.case tool function name to readable English.
 * e.g. "repos.list" -> "List Repos", "create_issue" -> "Create Issue"
 */
function humanizeName(name: string): string {
  const parts = name.replace(/[._]/g, " ").trim().split(/\s+/);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const verbs = new Set([
    "list",
    "create",
    "get",
    "update",
    "delete",
    "fetch",
    "search",
    "run",
    "trigger",
    "review",
    "send",
    "check",
  ]);

  const words = parts.map(capitalize);
  // If last word is a verb, move it to front for natural reading
  const lastWord = parts[parts.length - 1];
  if (words.length >= 2 && lastWord && verbs.has(lastWord)) {
    const verb = words.pop()!;
    return [verb, ...words].join(" ");
  }
  return words.join(" ");
}

interface Tool {
  name: string;
  description?: string;
}

interface Prompt {
  name: string;
  description?: string;
}

interface Resource {
  name: string;
  description?: string;
  uri?: string;
}

interface ConnectionCapabilitiesProps {
  tools: Tool[];
  prompts?: Prompt[];
  resources?: Resource[];
}

type Tab = "tools" | "prompts" | "resources";

function EmptyCapabilities({ label }: { label: string }) {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm text-muted-foreground">No {label} available.</p>
    </div>
  );
}

export function ConnectionCapabilities({
  tools,
  prompts = [],
  resources = [],
}: ConnectionCapabilitiesProps) {
  const hasTools = tools.length > 0;
  const hasPrompts = prompts.length > 0;
  const hasResources = resources.length > 0;

  const tabs = [
    {
      id: "tools" as Tab,
      label: "Tools",
      count: tools.length,
      icon: Tool01,
      show: true,
    },
    {
      id: "prompts" as Tab,
      label: "Prompts",
      count: prompts.length,
      icon: BookOpen01,
      show: hasPrompts,
    },
    {
      id: "resources" as Tab,
      label: "Resources",
      count: resources.length,
      icon: Columns01,
      show: hasResources,
    },
  ].filter((t) => t.show);

  const [activeTab, setActiveTab] = useState<Tab>("tools");

  // If the active tab has no content, reset to tools
  const resolvedTab =
    activeTab === "prompts" && !hasPrompts
      ? "tools"
      : activeTab === "resources" && !hasResources
        ? "tools"
        : activeTab;

  const totalItems = tools.length + prompts.length + resources.length;

  if (totalItems === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-1">
          Capabilities
        </h3>
        <p className="text-sm text-muted-foreground">
          No capabilities discovered yet. The connection may still be
          connecting.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Capabilities</h3>
        {tabs.length > 1 && (
          <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5",
                  resolvedTab === tab.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                <span
                  className={cn(
                    "text-[10px] tabular-nums",
                    resolvedTab === tab.id
                      ? "text-muted-foreground"
                      : "text-muted-foreground/60",
                  )}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        )}
        {tabs.length === 1 && (
          <p className="text-xs text-muted-foreground">
            {tools.length} {tools.length === 1 ? "tool" : "tools"}
          </p>
        )}
      </div>

      {resolvedTab === "tools" && (
        <div className="divide-y divide-border">
          {hasTools ? (
            tools.map((tool) => (
              <div key={tool.name} className="flex items-start gap-3 px-5 py-3">
                <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                  <Tool01 size={13} className="text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {humanizeName(tool.name)}
                  </div>
                  {tool.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                      {tool.description}
                    </div>
                  )}
                </div>
              </div>
            ))
          ) : (
            <EmptyCapabilities label="tools" />
          )}
        </div>
      )}

      {resolvedTab === "prompts" && (
        <div className="divide-y divide-border">
          {prompts.map((prompt) => (
            <div key={prompt.name} className="flex items-start gap-3 px-5 py-3">
              <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                <BookOpen01 size={13} className="text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {humanizeName(prompt.name)}
                </div>
                {prompt.description && (
                  <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                    {prompt.description}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {resolvedTab === "resources" && (
        <div className="divide-y divide-border">
          {resources.map((resource) => (
            <div
              key={resource.uri ?? resource.name}
              className="flex items-start gap-3 px-5 py-3"
            >
              <div className="mt-0.5 shrink-0 size-7 rounded-md bg-muted flex items-center justify-center">
                <Columns01 size={13} className="text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {resource.name}
                </div>
                {resource.description && (
                  <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                    {resource.description}
                  </div>
                )}
                {resource.uri && (
                  <div className="text-xs text-muted-foreground/60 font-mono mt-0.5 truncate">
                    {resource.uri}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
