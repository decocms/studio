/**
 * The Content tab of a Blocks site with no schema yet (`deco schema` hasn't
 * run): every saved block, grouped by `__resolveType`, each opening as plain
 * fields inferred from its JSON (text, numbers, switches, nested groups and
 * lists), plus the raw JSON editor. An edit replaces only the value it
 * touched, so a save writes every other value back exactly as it was read.
 *
 * A banner explains how to get the typed forms. Nothing here is a mode: the
 * editor's poll swaps the real schema in when it appears, and the regular
 * editor takes over (see `isNoSchemaMeta`).
 */

import { lazy, Suspense, useState } from "react";
import {
  ChevronLeft,
  Code01,
  InfoCircle,
  LinkExternal01,
  SearchMd,
  X,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { blocksDocs } from "@/lib/blocks-docs";
import { SCHEMA_COMMAND } from "@/components/sections-editor/deco-serve-connection";
import { CommandSnippet } from "@/components/sections-editor/deco-serve-notices";
import {
  groupBlocksByType,
  type JsonPath,
  parseNumberInput,
  setAtPath,
  typeLabel,
} from "@/components/sections-editor/schemaless";

const MonacoCodeEditor = lazy(() =>
  import("@/components/monaco-editor").then((m) => ({
    default: m.MonacoCodeEditor,
  })),
);

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The one notice of a site without a schema: what's missing and the fix. */
function SchemaPendingBanner({ className }: { className?: string }) {
  const t = useT();
  return (
    <section
      aria-labelledby="schema-pending-title"
      data-testid="schema-pending-banner"
      className={cn(
        "flex shrink-0 flex-col gap-2.5 border-b bg-muted/40 px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <InfoCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            id="schema-pending-title"
            className="text-sm font-medium text-foreground"
          >
            {t("sandbox.schemaless.bannerTitle")}
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("sandbox.schemaless.bannerBody")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-6">
        <div className="min-w-64 max-w-md flex-1">
          <CommandSnippet command={SCHEMA_COMMAND} />
        </div>
        <a
          href={blocksDocs.schema}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-foreground underline-offset-4 hover:underline focus-visible:underline"
        >
          {t("sandbox.schemaless.docsLink")}
          <LinkExternal01 aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{t("decoServe.docs.newTab")}</span>
        </a>
      </div>
    </section>
  );
}

function itemLabel(
  value: unknown,
  index: number,
  t: ReturnType<typeof useT>,
): string {
  if (isRecord(value)) {
    for (const key of ["name", "title", "label"]) {
      const text = value[key];
      if (typeof text === "string" && text.trim()) return text.trim();
    }
    if (typeof value.__resolveType === "string") {
      return typeLabel(value.__resolveType);
    }
    // Otherwise its first short line of text (a question, a link's label).
    for (const [key, text] of Object.entries(value)) {
      if (key.startsWith("__") || typeof text !== "string") continue;
      const line = text.trim();
      if (line && line.length <= 80 && !line.startsWith("<")) return line;
    }
  }
  return t("sandbox.schemaless.item", { n: index + 1 });
}

const fieldId = (path: JsonPath) => `schemaless-${path.join(".")}`;

function TextValue({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  // Decided once, so typing never swaps the control under the cursor.
  const [multiline] = useState(() => value.includes("\n") || value.length > 80);
  return multiline ? (
    <Textarea
      id={id}
      value={value}
      rows={Math.min(8, Math.max(3, value.split("\n").length))}
      onChange={(e) => onChange(e.target.value)}
    />
  ) : (
    <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

function NumberValue({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const t = useT();
  // The text being typed; the block only changes once it reads as a number.
  const [text, setText] = useState(String(value));
  const invalid = parseNumberInput(text) === null;
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseNumberInput(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
      />
      {invalid && (
        <p className="text-xs text-destructive">
          {t("sandbox.schemaless.notANumber")}
        </p>
      )}
    </div>
  );
}

/** One value, by its JSON type. */
function JsonValueField({
  label,
  value,
  path,
  depth,
  onChange,
}: {
  label: string;
  value: unknown;
  path: JsonPath;
  depth: number;
  onChange: (path: JsonPath, next: unknown) => void;
}) {
  const t = useT();
  const id = fieldId(path);

  if (typeof value === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="min-w-0 truncate">
          {label}
        </Label>
        <Switch
          id={id}
          checked={value}
          onCheckedChange={(next) => onChange(path, next)}
        />
      </div>
    );
  }
  if (typeof value === "string" || typeof value === "number") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id} className="min-w-0 truncate">
          {label}
        </Label>
        {typeof value === "string" ? (
          <TextValue
            id={id}
            value={value}
            onChange={(next) => onChange(path, next)}
          />
        ) : (
          <NumberValue
            id={id}
            value={value}
            onChange={(next) => onChange(path, next)}
          />
        )}
      </div>
    );
  }
  if (Array.isArray(value) || isRecord(value)) {
    const entries: [string, unknown, string | number][] = Array.isArray(value)
      ? value.map((item, index) => [itemLabel(item, index, t), item, index])
      : Object.entries(value)
          .filter(([key]) => key !== "__resolveType")
          .map(([key, item]) => [key, item, key]);
    const type =
      isRecord(value) && typeof value.__resolveType === "string"
        ? value.__resolveType
        : null;
    return (
      <details
        open={depth === 0}
        className="group rounded-md border border-border"
      >
        <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm font-medium text-foreground">
          <span className="min-w-0 truncate">{label}</span>
          {type && (
            <span
              className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground"
              title={type}
            >
              {typeLabel(type)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
            {Array.isArray(value)
              ? t("sandbox.schemaless.itemCount", { count: value.length })
              : null}
          </span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("sandbox.schemaless.empty")}
            </p>
          ) : (
            entries.map(([name, item, key]) => (
              <JsonValueField
                key={key}
                label={name}
                value={item}
                path={[...path, key]}
                depth={depth + 1}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </details>
    );
  }
  // null (and anything JSON can't type): shown, left as is.
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">
        {t("sandbox.schemaless.notSet")}
      </span>
    </div>
  );
}

/** A block's values as plain fields, plus its raw JSON. */
function SchemalessBlockEditor({
  blockKey,
  block,
  onChange,
  onBack,
}: {
  blockKey: string;
  block: JsonRecord;
  onChange: (blockKey: string, next: JsonRecord) => void;
  /** Shown as "All blocks" when the list isn't beside the editor. */
  onBack?: () => void;
}) {
  const t = useT();
  // Seeded once: the editor is remounted (by `key`) for another block.
  const [value, setValue] = useState<JsonRecord>(block);
  const [formKey, setFormKey] = useState(0);
  // `null`: the JSON view is closed. Monaco owns the text while it's open.
  const [jsonCode, setJsonCode] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState(false);

  const apply = (next: JsonRecord) => {
    setValue(next);
    onChange(blockKey, next);
  };
  const type =
    typeof value.__resolveType === "string" ? value.__resolveType : null;
  const fields = Object.entries(value).filter(
    ([key]) => key !== "__resolveType",
  );
  const toggleJson = () => {
    if (jsonCode !== null) {
      setJsonCode(null);
      setJsonError(false);
      // The fields keep their own typing state: re-read the JSON's values.
      setFormKey((k) => k + 1);
    } else {
      setJsonCode(JSON.stringify(value, null, 2));
    }
  };
  const onJsonChange = (text: string | undefined) => {
    try {
      const parsed = JSON.parse(text ?? "");
      if (isRecord(parsed)) {
        setJsonError(false);
        apply(parsed);
        return;
      }
    } catch {
      // Shown below; nothing is saved until it parses.
    }
    setJsonError(true);
  };
  const jsonLabel =
    jsonCode !== null
      ? t("sandbox.savedSectionEditor.closeJsonEditor")
      : t("sandbox.savedSectionEditor.editAsJson");

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onBack}
          >
            <ChevronLeft aria-hidden="true" />
            {t("sandbox.schemaless.back")}
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm font-medium" title={blockKey}>
            {blockKey}
          </h3>
          {type && (
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={type}
            >
              {type}
            </span>
          )}
        </div>
        <Button
          variant={jsonCode !== null ? "default" : "ghost"}
          size="icon"
          className="size-8 shrink-0"
          onClick={toggleJson}
          aria-label={jsonLabel}
          aria-pressed={jsonCode !== null}
          title={jsonLabel}
        >
          {jsonCode !== null ? <X size={14} /> : <Code01 size={14} />}
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          <form
            key={formKey}
            aria-label={blockKey}
            className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-4"
            onSubmit={(e) => e.preventDefault()}
          >
            {fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("sandbox.schemaless.empty")}
              </p>
            ) : (
              fields.map(([key, item]) => (
                <JsonValueField
                  key={key}
                  label={key}
                  value={item}
                  path={[key]}
                  depth={0}
                  onChange={(path, next) =>
                    apply(setAtPath(value, path, next) as JsonRecord)
                  }
                />
              ))
            )}
          </form>
        </div>
        {jsonCode !== null && (
          <div className="absolute inset-0 flex flex-col bg-background">
            {jsonError && (
              <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                {t("sandbox.savedSectionEditor.invalidJsonError")}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner className="size-5 text-muted-foreground" />
                  </div>
                }
              >
                <MonacoCodeEditor
                  language="json"
                  height="100%"
                  code={jsonCode}
                  onChange={onJsonChange}
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Every saved block with the banner on top. `compact` (a side panel) shows
 * the list or one block; otherwise the list sits beside the open block.
 */
export function SchemalessContent({
  decofile,
  onChange,
  onLeaveBlock,
  initialKey = null,
  compact = false,
}: {
  decofile: Record<string, unknown>;
  /** Saves one block's whole value (the caller debounces). */
  onChange: (blockKey: string, next: JsonRecord) => void;
  /** Leaving a block: the caller saves what's pending. */
  onLeaveBlock?: () => void;
  initialKey?: string | null;
  compact?: boolean;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(
    initialKey && isRecord(decofile[initialKey]) ? initialKey : null,
  );
  const [query, setQuery] = useState("");
  const select = (key: string | null) => {
    if (key === selected) return;
    onLeaveBlock?.();
    setSelected(key);
  };
  const block = selected ? decofile[selected] : undefined;
  const q = query.trim().toLowerCase();
  const groups = groupBlocksByType(decofile)
    .map((group) => ({
      ...group,
      blocks: q
        ? group.blocks.filter(
            (b) =>
              b.label.toLowerCase().includes(q) ||
              b.key.toLowerCase().includes(q) ||
              (group.resolveType ?? "").toLowerCase().includes(q),
          )
        : group.blocks,
    }))
    .filter((group) => group.blocks.length > 0);
  const total = Object.keys(decofile).length;

  const list = (
    <nav
      aria-label={t("sandbox.schemaless.listLabel")}
      className={cn(
        "flex min-h-0 flex-col",
        compact ? "flex-1" : "w-72 shrink-0 border-r",
      )}
    >
      <div className="shrink-0 border-b p-2">
        <div className="relative">
          <SearchMd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sandbox.schemaless.searchPlaceholder")}
            aria-label={t("sandbox.schemaless.searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {total === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("sandbox.schemaless.noBlocks")}
          </p>
        ) : groups.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("sandbox.schemaless.noMatches")}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.resolveType ?? ""}
              aria-label={group.resolveType ?? t("sandbox.schemaless.noType")}
              className="py-1"
            >
              <h3
                className="flex items-baseline gap-2 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                title={group.resolveType ?? undefined}
              >
                <span className="truncate">
                  {group.resolveType
                    ? typeLabel(group.resolveType)
                    : t("sandbox.schemaless.noType")}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {group.blocks.length}
                </span>
              </h3>
              <ul>
                {group.blocks.map((b) => (
                  <li key={b.key}>
                    <button
                      type="button"
                      onClick={() => select(b.key)}
                      aria-current={b.key === selected ? "true" : undefined}
                      title={b.key}
                      className={cn(
                        "block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        b.key === selected && "bg-accent font-medium",
                      )}
                    >
                      {b.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );

  const editor =
    selected && isRecord(block) ? (
      <SchemalessBlockEditor
        key={selected}
        blockKey={selected}
        block={block}
        onChange={onChange}
        onBack={compact ? () => select(null) : undefined}
      />
    ) : (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {t("sandbox.schemaless.pickBlock")}
        </p>
      </div>
    );

  return (
    <div
      data-testid="schemaless-content"
      className="flex h-full min-h-0 w-full flex-col"
    >
      <SchemaPendingBanner />
      <div className="flex min-h-0 flex-1">
        {compact ? (selected && isRecord(block) ? editor : list) : list}
        {!compact && editor}
      </div>
    </div>
  );
}
