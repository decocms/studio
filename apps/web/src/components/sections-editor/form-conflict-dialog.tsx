import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@decocms/ui/components/radio-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { formatRelativeTime } from "@/lib/format-time.ts";
import type { ConflictAuthor } from "./conflict-author";
import {
  type ConflictChoice,
  type ConflictChoices,
  type ConflictField,
  type DiffPart,
  diffWords,
  previewValue,
  type ValuePreview,
} from "./form-conflict";

/**
 * Asks the user, value by value, whose version to keep when they and someone
 * else changed the same fields of a section (form-conflict.ts). Every field
 * starts on "yours", so one click keeps the user's version. It must be
 * answered: an alert dialog with no close button, Escape or click outside;
 * nothing of the form's is saved until the user saves their choice.
 */
interface FormConflictChoicesProps {
  fields: ConflictField[];
  choices: ConflictChoices;
  /** Their version changed again while the dialog was open. */
  changedAgain?: boolean;
  /** Who made their change, and when; null (no line) while unknown. */
  author?: ConflictAuthor | null;
  onChoose: (pointer: string, choice: ConflictChoice) => void;
  onChooseAll: (choice: ConflictChoice) => void;
  onApply: () => void;
}

export function FormConflictDialog({
  open,
  ...props
}: FormConflictChoicesProps & { open: boolean }) {
  const t = useT();
  return (
    // Controlled with no onOpenChange: only saving a choice closes it.
    <AlertDialog open={open}>
      <AlertDialogContent
        className="sm:max-w-2xl max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)_auto]"
        data-testid="form-conflict-dialog"
        onEscapeKeyDown={(event) => event.preventDefault()}
        // An alert dialog focuses its Cancel button, and this one has none:
        // focus the dialog itself, so what the user was typing stops at it
        // (not the form behind, and not a button a space would press).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("sectionsEditor.formConflict.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("sectionsEditor.formConflict.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormConflictChoices {...props} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's body: the fields in conflict, their choices and the actions. */
export function FormConflictChoices({
  fields,
  choices,
  changedAgain = false,
  author = null,
  onChoose,
  onChooseAll,
  onApply,
}: FormConflictChoicesProps) {
  const t = useT();
  return (
    <>
      {author && <ConflictAuthorLine author={author} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          role="status"
          className={cn(
            "text-sm text-muted-foreground",
            !changedAgain && "sr-only",
          )}
        >
          {changedAgain ? t("sectionsEditor.formConflict.changedAgain") : ""}
        </p>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChooseAll("mine")}
          >
            {t("sectionsEditor.formConflict.keepYours")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChooseAll("theirs")}
          >
            {t("sectionsEditor.formConflict.useTheirs")}
          </Button>
        </div>
      </div>
      <div className="-mx-2 min-h-0 overflow-y-auto px-2">
        <ul className="flex flex-col gap-4">
          {fields.map((field) => (
            <ConflictFieldRow
              key={field.pointer}
              field={field}
              choice={choices[field.pointer]}
              onChoose={(choice) => onChoose(field.pointer, choice)}
            />
          ))}
        </ul>
      </div>
      <AlertDialogFooter className="items-center">
        <Button type="button" onClick={onApply}>
          {t("sectionsEditor.formConflict.apply")}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/**
 * "Changed by Ana Souza · 3 minutes ago" (the exact time on hover), with the
 * member's avatar when there is one; "You, in another tab or window · …" for
 * the viewer's own change, "Changed 5 minutes ago" when only the time is
 * known. Hosted v8 drafts only (the draft object's metadata).
 */
export function ConflictAuthorLine({
  author,
  now,
}: {
  author: ConflictAuthor;
  /** Fixed "now" (tests); the current time by default. */
  now?: number;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const date = new Date(author.at);
  const when = formatRelativeTime(date, language, now);
  const text = author.you
    ? t("sectionsEditor.formConflict.changedByYou", { when })
    : author.name
      ? t("sectionsEditor.formConflict.changedBy", { name: author.name, when })
      : t("sectionsEditor.formConflict.changedAt", { when });
  const avatarUrl = author.you ? undefined : author.avatarUrl;
  return (
    <p
      data-testid="form-conflict-author"
      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
    >
      {avatarUrl && (
        <Avatar
          url={avatarUrl}
          fallback={author.name?.charAt(0) ?? ""}
          shape="circle"
          size="xs"
          className="shrink-0"
        />
      )}
      <time
        dateTime={date.toISOString()}
        title={date.toLocaleString(language, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
        className="min-w-0 truncate"
      >
        {text}
      </time>
    </p>
  );
}

function ConflictFieldRow({
  field,
  choice,
  onChoose,
}: {
  field: ConflictField;
  choice: ConflictChoice | undefined;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const t = useT();
  const mine = previewValue(field.mine, field.schema);
  const theirs = previewValue(field.theirs, field.schema);
  const diff =
    mine.kind === "text" && theirs.kind === "text"
      ? diffWords(mine.text, theirs.text)
      : null;
  return (
    <li className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{field.label}</h3>
      <RadioGroup
        aria-label={field.label}
        value={choice ?? ""}
        onValueChange={(value) => onChoose(value as ConflictChoice)}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {(["mine", "theirs"] as const).map((side) => {
          const selected = choice === side;
          return (
            <label
              key={side}
              className={cn(
                "flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors",
                selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
              )}
            >
              <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <RadioGroupItem
                  value={side}
                  aria-label={t(
                    side === "mine"
                      ? "sectionsEditor.formConflict.keepYours"
                      : "sectionsEditor.formConflict.useTheirs",
                  )}
                />
                {t(
                  side === "mine"
                    ? "sectionsEditor.formConflict.yourVersion"
                    : "sectionsEditor.formConflict.theirVersion",
                )}
              </span>
              <span
                data-testid={`conflict-${side}`}
                className="min-w-0 text-sm"
              >
                {diff ? (
                  <DiffText parts={diff[side]} />
                ) : (
                  <Preview preview={side === "mine" ? mine : theirs} />
                )}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </li>
  );
}

function DiffText({ parts }: { parts: DiffPart[] }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.kind === "changed" ? (
          <mark
            key={i}
            className="rounded-sm bg-warning/20 px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function Preview({ preview }: { preview: ValuePreview }) {
  const t = useT();
  switch (preview.kind) {
    case "empty":
      return (
        <span className="italic text-muted-foreground">
          {t("sectionsEditor.formConflict.empty")}
        </span>
      );
    case "text":
      return (
        <span className="whitespace-pre-wrap break-words">{preview.text}</span>
      );
    case "image":
      return (
        <img
          src={preview.src}
          alt=""
          className="max-h-24 max-w-full rounded border object-contain"
        />
      );
    case "yesNo":
      return (
        <span>
          {t(
            preview.value
              ? "sectionsEditor.formConflict.yes"
              : "sectionsEditor.formConflict.no",
          )}
        </span>
      );
    case "list":
      return (
        <span className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {t(
              preview.count === 1
                ? "sectionsEditor.formConflict.oneItem"
                : "sectionsEditor.formConflict.items",
              { count: String(preview.count) },
            )}
          </span>
          {preview.items.some(Boolean) && (
            <span className="flex flex-col">
              {preview.items.map((item, i) => (
                <span key={i} className="truncate">
                  {`${i + 1}. ${item || "…"}`}
                </span>
              ))}
              {preview.count > preview.items.length && <span>…</span>}
            </span>
          )}
        </span>
      );
    case "fields":
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {preview.entries.map((entry) => (
            <div key={entry.label} className="contents">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="truncate">{entry.text}</dd>
            </div>
          ))}
        </dl>
      );
  }
}
