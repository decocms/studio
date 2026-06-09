import { Check } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import {
  AddButton,
  InlineText,
  RemoveButton,
  parseJsonArray,
  str,
} from "./primitives";

// ---------------------------------------------------------------- CardGroup

type Card = { icon?: string; title?: string; body?: string };

export function CardGroupBlock({
  cards,
  onChange,
}: {
  cards: string;
  onChange: (cards: string) => void;
}) {
  const items = parseJsonArray<Card>(cards);
  const commit = (next: Card[]) => onChange(JSON.stringify(next));
  const set = (i: number, patch: Partial<Card>) =>
    commit(items.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.slice(0, 3).map((card, i) => (
          <div
            key={i}
            className="group/item relative flex flex-col gap-2 rounded-lg border bg-card p-4"
          >
            <div className="absolute right-1 top-1">
              <RemoveButton
                label="Remove card"
                onClick={() => commit(items.filter((_, idx) => idx !== i))}
              />
            </div>
            <input
              value={str(card.icon)}
              onChange={(e) => set(i, { icon: e.target.value })}
              placeholder="🎴"
              className="flex h-9 w-9 items-center justify-center rounded-md border bg-background text-center text-lg outline-none focus:ring-0"
            />
            <input
              value={str(card.title)}
              onChange={(e) => set(i, { title: e.target.value })}
              placeholder="Card title"
              className="border-0 bg-transparent p-0 text-[15px] font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
            />
            <InlineText
              value={str(card.body)}
              onChange={(v) => set(i, { body: v })}
              placeholder="Card body"
              className="text-sm text-muted-foreground"
            />
          </div>
        ))}
      </div>
      {items.length < 3 && (
        <AddButton
          label="Add card"
          onClick={() => commit([...items, { title: "", body: "" }])}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Checklist

export function ChecklistBlock({
  title,
  items,
  onChange,
}: {
  title: string;
  items: string;
  onChange: (next: { title: string; items: string }) => void;
}) {
  const list = parseJsonArray<string>(items);
  const commit = (next: string[]) =>
    onChange({ title, items: JSON.stringify(next) });

  return (
    <div className="space-y-2">
      <input
        value={title}
        onChange={(e) => onChange({ title: e.target.value, items })}
        placeholder="Checklist title (optional)"
        className="w-full border-0 bg-transparent p-0 text-lg font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <ul>
        {list.map((item, i) => (
          <li
            key={i}
            className="group/item flex items-start gap-3 border-b border-border/50 py-2.5"
          >
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-primary">
              <Check size={15} />
            </span>
            <InlineText
              value={item}
              onChange={(v) =>
                commit(list.map((x, idx) => (idx === i ? v : x)))
              }
              placeholder="Checklist item"
              className="text-[15px] text-foreground"
            />
            <RemoveButton
              label="Remove item"
              onClick={() => commit(list.filter((_, idx) => idx !== i))}
            />
          </li>
        ))}
      </ul>
      <AddButton label="Add item" onClick={() => commit([...list, ""])} />
    </div>
  );
}

// ---------------------------------------------------------------- StatGroup

type StatItem = { value?: string; label?: string };

export function StatGroupBlock({
  stats,
  onChange,
}: {
  stats: string;
  onChange: (stats: string) => void;
}) {
  const items = parseJsonArray<StatItem>(stats);
  const commit = (next: StatItem[]) => onChange(JSON.stringify(next));
  const set = (i: number, patch: Partial<StatItem>) =>
    commit(items.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.slice(0, 3).map((stat, i) => (
          <div
            key={i}
            className="group/item relative rounded-lg border p-5 text-center"
          >
            <div className="absolute right-1 top-1">
              <RemoveButton
                label="Remove stat"
                onClick={() => commit(items.filter((_, idx) => idx !== i))}
              />
            </div>
            <input
              value={str(stat.value)}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder="99%"
              className="w-full border-0 bg-transparent p-0 text-center text-3xl font-bold tabular-nums text-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-0"
            />
            <input
              value={str(stat.label)}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder="Label"
              className="mt-1 w-full border-0 bg-transparent p-0 text-center text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-0"
            />
          </div>
        ))}
      </div>
      {items.length < 3 && (
        <AddButton
          label="Add stat"
          onClick={() => commit([...items, { value: "", label: "" }])}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Steps

type Step = { title?: string; description?: string };

export function StepsBlock({
  title,
  steps,
  onChange,
}: {
  title: string;
  steps: string;
  onChange: (next: { title: string; steps: string }) => void;
}) {
  const list = parseJsonArray<Step>(steps);
  const commit = (next: Step[]) =>
    onChange({ title, steps: JSON.stringify(next) });
  const set = (i: number, patch: Partial<Step>) =>
    commit(list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-2">
      <input
        value={title}
        onChange={(e) => onChange({ title: e.target.value, steps })}
        placeholder="Steps title (optional)"
        className="w-full border-0 bg-transparent p-0 text-lg font-semibold uppercase tracking-wide outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <ol className="space-y-3">
        {list.map((step, i) => (
          <li key={i} className="group/item flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1 pt-0.5">
              <input
                value={str(step.title)}
                onChange={(e) => set(i, { title: e.target.value })}
                placeholder="Step title"
                className="w-full border-0 bg-transparent p-0 text-[15px] font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
              />
              <InlineText
                value={str(step.description)}
                onChange={(v) => set(i, { description: v })}
                placeholder="Step description"
                className="text-sm text-muted-foreground"
              />
            </div>
            <RemoveButton
              label="Remove step"
              onClick={() => commit(list.filter((_, idx) => idx !== i))}
            />
          </li>
        ))}
      </ol>
      <AddButton
        label="Add step"
        onClick={() => commit([...list, { title: "", description: "" }])}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Comparison

type Col = { title?: string; items?: string[] };

function parseCol(value: string, fallbackTitle: string): Col {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      title: typeof parsed?.title === "string" ? parsed.title : fallbackTitle,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
    };
  } catch {
    return { title: fallbackTitle, items: [] };
  }
}

export function ComparisonBlock({
  left,
  right,
  onChange,
}: {
  left: string;
  right: string;
  onChange: (next: { left: string; right: string }) => void;
}) {
  const cols = {
    left: parseCol(left, "Option A"),
    right: parseCol(right, "Option B"),
  };

  const commit = (side: "left" | "right", col: Col) =>
    onChange({
      left: side === "left" ? JSON.stringify(col) : left,
      right: side === "right" ? JSON.stringify(col) : right,
    });

  const renderCol = (side: "left" | "right", col: Col, accent: string) => {
    const itemsList = col.items ?? [];
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <input
          value={str(col.title)}
          onChange={(e) => commit(side, { ...col, title: e.target.value })}
          placeholder="Column title"
          className="w-full border-0 bg-transparent p-0 text-xs font-semibold uppercase tracking-wide outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
        <ul className="space-y-1.5">
          {itemsList.map((item, i) => (
            <li key={i} className="group/item flex items-start gap-2">
              <span
                aria-hidden
                className="mt-0.5 shrink-0 text-sm font-bold"
                style={{ color: accent }}
              >
                ✓
              </span>
              <InlineText
                value={item}
                onChange={(v) =>
                  commit(side, {
                    ...col,
                    items: itemsList.map((x, idx) => (idx === i ? v : x)),
                  })
                }
                placeholder="Item"
                className="text-sm text-foreground"
              />
              <RemoveButton
                label="Remove item"
                onClick={() =>
                  commit(side, {
                    ...col,
                    items: itemsList.filter((_, idx) => idx !== i),
                  })
                }
              />
            </li>
          ))}
        </ul>
        <AddButton
          label="Add item"
          onClick={() => commit(side, { ...col, items: [...itemsList, ""] })}
        />
      </div>
    );
  };

  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2")}>
      {renderCol("left", cols.left, "oklch(0.65 0.17 150)")}
      {renderCol("right", cols.right, "oklch(0.75 0.15 75)")}
    </div>
  );
}
