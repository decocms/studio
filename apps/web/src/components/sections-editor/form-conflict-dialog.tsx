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
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useState,
} from "react";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { authClient } from "@/lib/auth-client";
import { formatRelativeTime } from "@/lib/format-time.ts";
import { isTypingTarget } from "@/lib/keyboard-shortcuts.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  type ConflictChoice,
  type ConflictChoices,
  type ConflictField,
  type ConflictFreshness,
  type DiffPart,
  diffWords,
  previewValue,
  type ValuePreview,
} from "./form-conflict";
import type { ConflictAuthor } from "./conflict-author";

/**
 * Asks the user whose version to keep when they and someone else changed the
 * same fields of a section (form-conflict.ts): two cards, theirs and yours,
 * the whole card being the choice. Two or more fields: the same cards, one
 * field per step, with a dot per field to revisit one (Back and the ←/→ keys
 * too), and on the last step a summary of the picks. Every field starts on
 * "yours", so one click keeps the user's version: OK saves the picks (Next
 * on every step but the last). On hosted v8 drafts their card names the
 * member, with their avatar and when they saved (conflict-author.ts), and so
 * do the titles; elsewhere "Someone else". It must be answered: an alert
 * dialog with no close button, Escape or click outside; nothing of the form's
 * is saved until then.
 */
interface FormConflictChoicesProps {
  fields: ConflictField[];
  choices: ConflictChoices;
  /** Their version changed again while the dialog was open. */
  changedAgain?: boolean;
  /** How often each field's "their" version changed while open (a ring on its dot). */
  fresh?: ConflictFreshness;
  /** The signed-in user, for the avatar on their card. */
  viewer?: ConflictViewer | null;
  /** Who made their change, and when; null while unknown. */
  author?: ConflictAuthor | null;
  /**
   * Who made it wasn't known yet when the window opened (hosted v8): the
   * titles name no one, and stay so when the name lands on their card.
   */
  anonymousTitle?: boolean;
  /**
   * Fields named as their form labels them, "the Headline" (hosted v8),
   * never lowercased into the sentence.
   */
  fieldsAsLabeled?: boolean;
  /**
   * The block the fields belong to, by its title, when the dialog isn't
   * opened from the block's own form (a global section's editor, a loader's…).
   */
  block?: string;
  onChoose: (pointer: string, choice: ConflictChoice) => void;
  onApply: () => void;
  /**
   * The title and description as the dialog shows them (the alert dialog's
   * own, which name it for assistive tech); a plain heading by default.
   */
  heading?: (title: string, description: ReactNode) => ReactNode;
}

export interface ConflictViewer {
  name?: string | null;
  image?: string | null;
}

export function FormConflictDialog({
  open,
  authorPending = false,
  waitForAuthor = false,
  ...props
}: FormConflictChoicesProps & {
  open: boolean;
  /**
   * Who made the other change is still being read (conflict-author.ts).
   * The dialog opens at once all the same; its titles then name no one for
   * as long as it is open (never "Someone else" switching to a name), and
   * the name lands on their card when it is known.
   */
  authorPending?: boolean;
  /**
   * Waits for who made it before opening instead (the A/B test and
   * campaign windows, named from the members already read).
   */
  waitForAuthor?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const waiting = waitForAuthor && authorPending;
  // Decided when it first shows (the dialog is mounted per conflict).
  const [anonymousTitle] = useState(() => authorPending && !waitForAuthor);
  return (
    // Controlled with no onOpenChange: only saving a choice closes it.
    <AlertDialog open={open && !waiting}>
      <AlertDialogContent
        className={cn(
          "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg",
        )}
        data-testid="form-conflict-dialog"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <FormConflictChoices
          {...props}
          anonymousTitle={props.anonymousTitle ?? anonymousTitle}
          viewer={session?.user ?? null}
          heading={(title, description) => (
            <AlertDialogHeader className="text-left">
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </AlertDialogHeader>
          )}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

const noneFresh: ConflictFreshness = {};

const plainHeading = (title: string, description: ReactNode) => (
  <div className="flex flex-col gap-2">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-sm text-muted-foreground">{description}</p>
  </div>
);

/**
 * One field: "Ana changed the title while you were editing". A step of
 * several: "Ana also changed the title", and on the last one a summary of the
 * picks instead of the hint. "Someone else" while who is unknown, "You … in
 * another tab or window" for the viewer's own change.
 */
export function conflictHeading(
  t: TFunction,
  fields: readonly ConflictField[],
  step = 0,
  choices: ConflictChoices = {},
  author: ConflictAuthor | null = null,
  block?: string,
  {
    anonymous = false,
    asLabeled = false,
  }: {
    /** Titles that name no one (who made it unknown when it opened). */
    anonymous?: boolean;
    /** The field as its form labels it (hosted v8). */
    asLabeled?: boolean;
  } = {},
): { title: string; description: ReactNode } {
  const field = fields[Math.min(step, fields.length - 1)];
  const name = author?.you
    ? undefined
    : (author?.shortName ?? author?.name?.split(/\s+/)[0]);
  const vars = {
    // A hosted v8 window (one that names the block, or the section form's
    // own there) names the field as its form labels it: "the About of",
    // never "the about of".
    field: field
      ? block || asLabeled
        ? field.label
        : fieldInSentence(field.label)
      : "",
    label: field?.label ?? "",
    name: name ?? "",
    block: block ?? "",
  };
  type Key = Parameters<TFunction>[0];
  const pick = (one: Key, named: Key, you: Key, nobody: Key) =>
    t(anonymous ? nobody : author?.you ? you : name ? named : one, vars);
  const phrase = field?.phrase;
  const phraseTitle = (one: Key, named: Key, you: Key, nobody: Key) =>
    t(anonymous ? nobody : author?.you ? you : name ? named : one, {
      thing: phrase ?? "",
      Thing: phrase
        ? phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1)
        : "",
      label: field?.label ?? "",
      name: name ?? "",
    });
  if (phrase) {
    return fields.length <= 1
      ? {
          title: phraseTitle(
            "sectionsEditor.formConflict.titlePhraseOne",
            "sectionsEditor.formConflict.titlePhraseOneNamed",
            "sectionsEditor.formConflict.titlePhraseOneYou",
            "sectionsEditor.formConflict.titlePhraseOneAnonymous",
          ),
          description: t("sectionsEditor.formConflict.descriptionOne"),
        }
      : {
          title: phraseTitle(
            "sectionsEditor.formConflict.titlePhraseStep",
            "sectionsEditor.formConflict.titlePhraseStepNamed",
            "sectionsEditor.formConflict.titlePhraseStepYou",
            "sectionsEditor.formConflict.titlePhraseStepAnonymous",
          ),
          description:
            step >= fields.length - 1 ? (
              <ConflictSummary
                t={t}
                fields={fields}
                choices={choices}
                name={name}
              />
            ) : (
              t("sectionsEditor.formConflict.descriptionStep")
            ),
        };
  }
  if (fields.length <= 1) {
    return {
      title: block
        ? pick(
            "sectionsEditor.formConflict.titleOneIn",
            "sectionsEditor.formConflict.titleOneInNamed",
            "sectionsEditor.formConflict.titleOneInYou",
            "sectionsEditor.formConflict.titleOneInAnonymous",
          )
        : pick(
            "sectionsEditor.formConflict.titleOne",
            "sectionsEditor.formConflict.titleOneNamed",
            "sectionsEditor.formConflict.titleOneYou",
            "sectionsEditor.formConflict.titleOneAnonymous",
          ),
      description: t("sectionsEditor.formConflict.descriptionOne"),
    };
  }
  return {
    title: block
      ? pick(
          "sectionsEditor.formConflict.titleStepIn",
          "sectionsEditor.formConflict.titleStepInNamed",
          "sectionsEditor.formConflict.titleStepInYou",
          "sectionsEditor.formConflict.titleStepInAnonymous",
        )
      : pick(
          "sectionsEditor.formConflict.titleStep",
          "sectionsEditor.formConflict.titleStepNamed",
          "sectionsEditor.formConflict.titleStepYou",
          "sectionsEditor.formConflict.titleStepAnonymous",
        ),
    description:
      step >= fields.length - 1 ? (
        <ConflictSummary t={t} fields={fields} choices={choices} name={name} />
      ) : (
        t("sectionsEditor.formConflict.descriptionStep")
      ),
  };
}

/**
 * "Title: yours · Button text: theirs", one entry per field ("Ana's" when
 * the member is known; pt-br keeps "a deles").
 */
function ConflictSummary({
  t,
  fields,
  choices,
  name,
}: {
  t: TFunction;
  fields: readonly ConflictField[];
  choices: ConflictChoices;
  name?: string;
}) {
  return (
    <span data-testid="form-conflict-summary">
      {fields.map((field, i) => (
        <Fragment key={field.pointer}>
          {i > 0 && " · "}
          {`${field.label}: `}
          <span className="font-medium text-foreground">
            {t(
              (choices[field.pointer] ?? "mine") === "mine"
                ? "sectionsEditor.formConflict.summaryYours"
                : name
                  ? "sectionsEditor.formConflict.summaryTheirsNamed"
                  : "sectionsEditor.formConflict.summaryTheirs",
              { name: name ?? "" },
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A field's label inside an English sentence: "Title" -> "title"; a path
 * ("Cta › Label") or an acronym ("SEO") as labeled.
 */
export function fieldInSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) && !label.includes("›")
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}

/**
 * The dialog's header, body and actions: the two cards for one field; for
 * several, the same cards one field per step, with Back / Next and the dots,
 * OK on the last step saving.
 */
export function FormConflictChoices(props: FormConflictChoicesProps) {
  const t = useT();
  const {
    fields,
    choices,
    changedAgain = false,
    fresh = noneFresh,
    heading = plainHeading,
  } = props;
  const many = fields.length > 1;
  const [step, setStep] = useState(0);
  // Fields the user moved on from (a filled dot), and the change count of
  // their version each field last showed (a ring while it went up since).
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [seen, setSeen] = useState<ConflictFreshness>({});
  const at = Math.max(0, Math.min(step, fields.length - 1));
  const field = fields[at];
  const last = at === fields.length - 1;

  const go = (to: number) => {
    const from = fields[at];
    const next = fields[to];
    if (!from || !next || to === at) return;
    setAnswered((now) => new Set(now).add(from.pointer));
    setSeen((now) => ({
      ...now,
      [from.pointer]: fresh[from.pointer] ?? 0,
      [next.pointer]: fresh[next.pointer] ?? 0,
    }));
    setStep(to);
  };
  // The ←/→ keys move between the steps, except in a text field (the dialog
  // has none). It is modal: every key pressed while it is open is meant for
  // it, wherever its focus is.
  const listenForStepKeys = (el: HTMLElement | null) => {
    if (!el) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const by = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[
        event.key
      ];
      if (
        !by ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      go(at + by);
    };
    el.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => el.ownerDocument.removeEventListener("keydown", onKeyDown);
  };

  if (!field) return null;
  const { title, description } = conflictHeading(
    t,
    fields,
    at,
    choices,
    props.author ?? null,
    props.block,
    { anonymous: props.anonymousTitle, asLabeled: props.fieldsAsLabeled },
  );
  // The second click of a double click on Next would land on the button that
  // saves, in the same place on the last step: only a click of its own saves.
  const apply = (event: MouseEvent) => {
    if (event.detail > 1) return;
    props.onApply();
  };

  return (
    <>
      <div
        ref={many ? listenForStepKeys : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        {many && (
          <div className="flex items-center justify-between gap-3">
            <div
              role="group"
              aria-label={t("sectionsEditor.formConflict.steps")}
              className="-m-1 flex flex-wrap items-center"
            >
              {fields.map((item, i) => {
                const ringed =
                  i !== at &&
                  (fresh[item.pointer] ?? 0) > (seen[item.pointer] ?? 0);
                return (
                  <button
                    key={item.pointer}
                    type="button"
                    aria-label={
                      ringed
                        ? t("sectionsEditor.formConflict.stepChangedAgain", {
                            label: item.label,
                          })
                        : item.label
                    }
                    aria-current={i === at ? "step" : undefined}
                    data-answered={
                      i !== at && answered.has(item.pointer) ? "" : undefined
                    }
                    data-changed-again={ringed ? "" : undefined}
                    onClick={() => go(i)}
                    className="group cursor-pointer rounded-full p-1 focus-ring"
                  >
                    <span
                      className={cn(
                        "block h-2 w-2 rounded-full bg-border transition-[width,background-color,box-shadow] motion-reduce:transition-none",
                        "group-hover:bg-muted-foreground/60",
                        "group-data-[answered]:bg-foreground/45",
                        "group-aria-[current=step]:w-5 group-aria-[current=step]:bg-foreground",
                        "group-data-[changed-again]:ring-2 group-data-[changed-again]:ring-warning group-data-[changed-again]:ring-offset-1 group-data-[changed-again]:ring-offset-background",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t("sectionsEditor.formConflict.stepCount", {
                step: String(at + 1),
                count: String(fields.length),
              })}
            </span>
          </div>
        )}
        {heading(title, description)}
      </div>
      <div className="-mx-2 flex min-h-0 flex-col gap-3 overflow-y-auto px-2 py-1">
        <p
          role="status"
          className={cn(
            "text-sm text-muted-foreground",
            !changedAgain && "sr-only",
          )}
        >
          {changedAgain
            ? t(
                many
                  ? "sectionsEditor.formConflict.changedAgainSteps"
                  : "sectionsEditor.formConflict.changedAgain",
              )
            : ""}
        </p>
        <ConflictCards
          field={field}
          {...props}
          arrows={many ? "vertical" : "all"}
        />
      </div>
      {many ? (
        <AlertDialogFooter className="flex-row flex-wrap items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            aria-disabled={at === 0}
            onClick={() => go(at - 1)}
            className="aria-disabled:cursor-default aria-disabled:opacity-45"
          >
            {t("sectionsEditor.formConflict.back")}
          </Button>
          <Button
            type="button"
            data-testid="form-conflict-primary"
            onClick={last ? apply : () => go(at + 1)}
          >
            {t(
              last
                ? "sectionsEditor.formConflict.ok"
                : "sectionsEditor.formConflict.next",
            )}
          </Button>
        </AlertDialogFooter>
      ) : (
        <AlertDialogFooter className="items-center gap-2">
          <Button
            type="button"
            data-testid="form-conflict-primary"
            onClick={apply}
          >
            {t("sectionsEditor.formConflict.ok")}
          </Button>
        </AlertDialogFooter>
      )}
    </>
  );
}

/** Both sides' values, with the words that differ marked when both are text. */
function sides(field: ConflictField) {
  const mine = previewValue(field.mine, field.schema);
  const theirs = previewValue(field.theirs, field.schema);
  const diff =
    mine.kind === "text" && theirs.kind === "text"
      ? diffWords(mine.text, theirs.text)
      : null;
  return (side: ConflictChoice) =>
    diff ? (
      <DiffText parts={diff[side]} />
    ) : (
      <Preview preview={side === "mine" ? mine : theirs} />
    );
}

const radioSteps: Record<"all" | "vertical", Record<string, number>> = {
  all: { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 },
  // Several fields: ←/→ move between the steps.
  vertical: { ArrowDown: 1, ArrowUp: -1 },
};

/**
 * Arrow keys move the choice between a group's radios, as native radios do;
 * Space and Enter press the focused one (they are buttons).
 */
function onRadioKeyDown(
  event: KeyboardEvent<HTMLElement>,
  arrows: "all" | "vertical",
) {
  const step = radioSteps[arrows][event.key];
  if (!step) return;
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

/** A field: the user's card and the other person's, the whole card a radio. */
function ConflictCards({
  field,
  choices,
  viewer,
  author = null,
  anonymousTitle = false,
  onChoose,
  arrows,
}: FormConflictChoicesProps & {
  field: ConflictField;
  arrows: "all" | "vertical";
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const value = sides(field);
  const choice = choices[field.pointer] ?? "mine";
  const viewerAvatar = (
    <Avatar
      url={viewer?.image ?? undefined}
      fallback={viewer?.name?.trim() || t("sectionsEditor.formConflict.you")}
      shape="circle"
      size="sm"
      className="text-xs"
    />
  );
  const theirAvatar = author?.you ? (
    viewerAvatar
  ) : author?.name ? (
    <Avatar
      url={author.avatarUrl}
      fallback={author.name}
      shape="circle"
      size="sm"
      className="text-xs"
    />
  ) : (
    <Avatar url="icon://user" fallback="" muted shape="circle" size="sm" />
  );
  const savedAt = author ? new Date(author.at) : null;
  // Opened before who made it was known (hosted v8): until the name lands,
  // their card names no one and claims no one ("Their version · already
  // saved"), and keeps that if it never does.
  const neutral = anonymousTitle && !author;
  return (
    <div
      role="radiogroup"
      aria-label={field.label}
      className="flex flex-col gap-2"
      onKeyDown={(event) => onRadioKeyDown(event, arrows)}
    >
      <ConflictCard
        side="mine"
        checked={choice === "mine"}
        onChoose={() => onChoose(field.pointer, "mine")}
        avatar={viewerAvatar}
        who={t("sectionsEditor.formConflict.you")}
        meta={t("sectionsEditor.formConflict.yourVersionNotSaved")}
      >
        {value("mine")}
      </ConflictCard>
      <ConflictCard
        side="theirs"
        checked={choice === "theirs"}
        onChoose={() => onChoose(field.pointer, "theirs")}
        avatar={theirAvatar}
        who={
          neutral
            ? t("sectionsEditor.formConflict.theirVersion")
            : author?.you
              ? t("sectionsEditor.formConflict.youElsewhere")
              : author?.name || t("sectionsEditor.formConflict.someoneElse")
        }
        meta={
          neutral
            ? t("sectionsEditor.formConflict.alreadySaved")
            : savedAt
              ? t("sectionsEditor.formConflict.savedAt", {
                  when: formatRelativeTime(savedAt, language),
                })
              : t("sectionsEditor.formConflict.theirVersionSaved")
        }
        metaTitle={savedAt ? exactTime(savedAt, language) : undefined}
      >
        {value("theirs")}
      </ConflictCard>
    </div>
  );
}

const exactTime = (date: Date, language: string) =>
  date.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });

function ConflictCard({
  side,
  checked,
  onChoose,
  avatar,
  who,
  meta,
  metaTitle,
  children,
}: {
  side: ConflictChoice;
  checked: boolean;
  onChoose: () => void;
  avatar: ReactNode;
  who: string;
  meta: string;
  /** The exact time, on hover. */
  metaTitle?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={`${id}-who`}
      aria-describedby={`${id}-meta ${id}-value`}
      tabIndex={checked ? 0 : -1}
      onClick={onChoose}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-xl border bg-background p-3 text-left transition-[border-color,box-shadow,background-color] focus-ring",
        checked
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "hover:bg-accent",
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
          <span
            id={`${id}-who`}
            className="text-sm font-medium text-foreground"
          >
            {who}
          </span>
          <span id={`${id}-meta`} title={metaTitle}>
            {meta}
          </span>
        </span>
        <span
          id={`${id}-value`}
          data-testid={`conflict-${side}`}
          className="min-w-0 text-sm"
        >
          {children}
        </span>
      </span>
    </button>
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
