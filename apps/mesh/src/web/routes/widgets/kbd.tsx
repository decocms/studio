import { useWidget } from "./use-widget.ts";

type Shortcut = { keys: string[]; description: string };
type KbdArgs = { shortcuts?: Shortcut[] };

export default function Kbd() {
  const { args } = useWidget<KbdArgs>();

  if (!args) return null;

  const { shortcuts = [] } = args;

  if (shortcuts.length === 0) {
    return (
      <div className="p-4 font-sans text-sm text-muted-foreground text-center py-4">
        No shortcuts defined
      </div>
    );
  }

  return (
    <div className="p-4 font-sans">
      <ul className="space-y-2">
        {shortcuts.map((shortcut, i) => (
          <li key={i} className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {shortcut.description}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {shortcut.keys.map((key, j) => (
                <span key={j} className="flex items-center gap-1">
                  <kbd className="px-2 py-0.5 text-xs font-mono font-medium text-foreground bg-muted border border-border rounded shadow-sm">
                    {key}
                  </kbd>
                  {j < shortcut.keys.length - 1 && (
                    <span className="text-muted-foreground text-xs">+</span>
                  )}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
