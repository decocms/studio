import { useState } from "react";
import { useWidget } from "./use-widget.ts";

type JsonViewerArgs = { data?: unknown; title?: string };

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 1);

  if (value === null)
    return <span className="text-muted-foreground">null</span>;
  if (typeof value === "boolean")
    return <span className="text-blue-500">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-orange-500 tabular-nums">{value}</span>;
  if (typeof value === "string")
    return <span className="text-green-600">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-muted-foreground">[]</span>;
    return (
      <span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs"
        >
          {collapsed ? `[…${value.length}]` : "["}
        </button>
        {!collapsed && (
          <>
            <div className="ml-4">
              {value.map((item, i) => (
                <div key={i} className="text-xs font-mono leading-5">
                  <JsonNode value={item} depth={depth + 1} />
                  {i < value.length - 1 && (
                    <span className="text-muted-foreground">,</span>
                  )}
                </div>
              ))}
            </div>
            <span className="text-muted-foreground font-mono text-xs">]</span>
          </>
        )}
      </span>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0)
      return <span className="text-muted-foreground">{"{}"}</span>;
    return (
      <span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs"
        >
          {collapsed ? `{…${entries.length}}` : "{"}
        </button>
        {!collapsed && (
          <>
            <div className="ml-4">
              {entries.map(([k, v], i) => (
                <div key={k} className="text-xs font-mono leading-5">
                  <span className="text-foreground">"{k}"</span>
                  <span className="text-muted-foreground">: </span>
                  <JsonNode value={v} depth={depth + 1} />
                  {i < entries.length - 1 && (
                    <span className="text-muted-foreground">,</span>
                  )}
                </div>
              ))}
            </div>
            <span className="text-muted-foreground font-mono text-xs">
              {"}"}
            </span>
          </>
        )}
      </span>
    );
  }

  return (
    <span className="text-foreground font-mono text-xs">{String(value)}</span>
  );
}

export default function JsonViewer() {
  const { args } = useWidget<JsonViewerArgs>();

  if (!args) return null;

  const { data, title = "JSON" } = args;

  return (
    <div className="p-4 font-sans">
      {title && (
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {title}
        </div>
      )}
      <div className="bg-muted rounded-lg p-3 overflow-auto max-h-64">
        <div className="text-xs font-mono leading-5">
          <JsonNode value={data} depth={0} />
        </div>
      </div>
    </div>
  );
}
