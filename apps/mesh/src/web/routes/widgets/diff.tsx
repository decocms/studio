import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type DiffArgs = { before?: string; after?: string; title?: string };

type DiffLine = { type: "removed" | "added" | "unchanged"; text: string };

function computeDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const m = beforeLines.length;
  const n = afterLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const b = beforeLines[i - 1];
      const a = afterLines[j - 1];
      // biome-ignore lint/style/noNonNullAssertion: dp is sized m+1 x n+1
      dp[i]![j] =
        b === a
          ? (dp[i - 1]?.[j - 1] ?? 0) + 1
          : Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
    }
  }

  // Traceback
  const ops: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const b = beforeLines[i - 1];
    const a = afterLines[j - 1];
    if (i > 0 && j > 0 && b === a) {
      ops.push({ type: "unchanged", text: b ?? "" });
      i--;
      j--;
    } else if (
      j > 0 &&
      (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))
    ) {
      ops.push({ type: "added", text: a ?? "" });
      j--;
    } else {
      ops.push({ type: "removed", text: b ?? "" });
      i--;
    }
  }

  return ops.reverse();
}

export default function Diff() {
  const { args } = useWidget<DiffArgs>();

  if (!args) return null;

  const { before = "", after = "", title = "Diff" } = args;
  const lines = computeDiff(before, after);

  return (
    <div className="p-4 font-sans">
      {title && (
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {title}
        </div>
      )}
      <div className="bg-muted rounded-lg overflow-auto max-h-64 text-xs font-mono">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "px-3 py-0.5 leading-5 whitespace-pre-wrap break-all",
              line.type === "added"
                ? "bg-green-50 text-green-800"
                : line.type === "removed"
                  ? "bg-red-50 text-red-800"
                  : "text-foreground",
            )}
          >
            <span className="select-none mr-2 text-muted-foreground">
              {line.type === "added"
                ? "+"
                : line.type === "removed"
                  ? "-"
                  : " "}
            </span>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
