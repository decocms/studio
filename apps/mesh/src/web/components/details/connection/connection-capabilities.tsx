import { Tool01 } from "@untitledui/icons";

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

interface ConnectionCapabilitiesProps {
  tools: Array<{
    name: string;
    description?: string;
  }>;
}

export function ConnectionCapabilities({ tools }: ConnectionCapabilitiesProps) {
  if (tools.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-1">
          Capabilities
        </h3>
        <p className="text-sm text-muted-foreground">
          No tools discovered yet. The connection may still be connecting.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Capabilities</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {tools.length} {tools.length === 1 ? "tool" : "tools"} available
        </p>
      </div>
      <div className="divide-y divide-border">
        {tools.map((tool) => (
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
        ))}
      </div>
    </div>
  );
}
